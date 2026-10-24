"""Bounded source processing. PostgreSQL owns effects; Redis avoids duplicate work."""
import hashlib
import json
from functools import partial
from dataclasses import dataclass
from datetime import date, datetime, timezone, timedelta
from pathlib import Path
from typing import Literal
from uuid import UUID, uuid4

from pydantic import Field, model_validator
from openai import BadRequestError, AuthenticationError, PermissionDeniedError, NotFoundError
from sqlalchemy import select, update, delete, and_, or_, func, text, case
from sqlalchemy.dialects.postgresql import insert, array

from ..connectors import Session, run_sql
from ..env import CONFIG, ProfileConfig
from ..models.database import Project, User, UserProfile, UserEvent, DEFAULT_PROJECT_ID
from ..models.source import (
    StrictModel, ImportSource, DeleteMessages, UpdateFact, DeleteFact, Operation, Source, SourceSummary, Evidence, Blob,
    memory_sources as sources, memory_operations as operations,
    memory_blobs as blobs, memory_messages as messages,
    memory_facts as facts, user_memory_states as states,
    memory_profile_revisions as revisions, HistoryEntry,
    user_memory_tombstones as tombstones, ForgottenUser,
    FactTime,
    memory_event_facts as event_facts,
)
from ..temporal import supported_fact_time, source_observations, render_search_fact
from ..utils import get_encoded_tokens
from ..llms.openai_model_llm import openai_complete
from ..llms import record_completion_usage
from ..llms.embeddings import get_embedding
from .user_lease import UserLease, LeaseUnavailable, LeaseLost


class SourceError(Exception):
    def __init__(self, code: str, message: str, status: int = 400, retryable: bool = False):
        self.code, self.message, self.status, self.retryable = code, message, status, retryable
        super().__init__(message)


class FactStatement(StrictModel):
    content: str = Field(min_length=1, max_length=4096)
    subject: str = Field(min_length=1, max_length=512)
    reporter: str = Field(min_length=1, max_length=512)
    certainty: str = Field(pattern=r"^(asserted|reported|uncertain)$")
    fact_time: FactTime | None


class ExtractedFact(FactStatement):
    support_groups: list[list[str]] = Field(min_length=1, max_length=20)

    @model_validator(mode="after")
    def nonempty_groups(self):
        if any(not group or len(group) != len(set(group)) for group in self.support_groups):
            raise ValueError("Every evidence group must contain distinct message IDs")
        if len({tuple(sorted(group)) for group in self.support_groups}) != len(self.support_groups):
            raise ValueError("Repeated message groups are not independent evidence")
        return self


class Extraction(StrictModel):
    facts: list[ExtractedFact] = Field(max_length=200)


class EvidenceAlternative(StrictModel):
    all_of: list[str] = Field(min_length=1)


class DatedFactTime(FactTime):
    start: date
    end: date
    precision: Literal["year", "month", "day", "range"]


class UnresolvedFactTime(FactTime):
    start: None
    end: None
    precision: Literal["unknown"]


class MessageFact(FactStatement):
    # Expose the null/precision relationship in the model's schema; inherit the
    # canonical calendar checks without changing the stored/public time shape.
    fact_time: DatedFactTime | UnresolvedFactTime | None
    any_of: list[EvidenceAlternative] = Field(min_length=1, max_length=20)


class MessageFacts(StrictModel):
    message_id: str
    facts: list[MessageFact] = Field(max_length=200)


class MessageExtraction(StrictModel):
    messages: list[MessageFacts] = Field(max_length=1000)


def _normalize_extraction(result: MessageExtraction, request: ImportSource) -> Extraction:
    """Resolve the model's message buckets once; storage keeps the evidence contract."""
    user_ids = [m.message_id for m in request.messages if m.role == "user"]
    buckets = {item.message_id: item for item in result.messages}
    if len(buckets) != len(result.messages) or set(buckets) != set(user_ids):
        raise SourceError("invalid_model_output", "Extraction must cover each supplied user message exactly once", 502, True)
    output = []
    for message_id in user_ids:
        for fact in buckets[message_id].facts:
            groups = [alternative.all_of for alternative in fact.any_of]
            if not any(message_id in group for group in groups):
                raise SourceError("invalid_model_output", "Fact must be supported by its source message", 502, True)
            output.append({**fact.model_dump(exclude={"any_of"}), "support_groups": groups})
    try:
        return Extraction.model_validate({"facts": output})
    except ValueError as error:
        raise SourceError("invalid_model_output", "Fact evidence or total count is invalid", 502, True) from error


@dataclass
class ExtractedSource:
    facts: list[dict]


EXTRACT_SYSTEM = (Path(__file__).parent.parent / "prompts" / "fact_extraction.md").read_text(
    encoding="utf-8").strip()
# Keep the stored key so in-flight operations retain their existing expiry/ownership boundary.
_EXTRACTION_CANDIDATE = "fact_review_candidate"


def _identity(user_id, project_id):
    return and_(states.c.user_id == user_id, states.c.project_id == project_id)


def _scope(table, user_id, project_id):
    return and_(table.c.user_id == user_id, table.c.project_id == project_id)


def _hash(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()


def lock_user_identity(session, user_id, project_id, *, wait=True):
    # Transaction-scoped PostgreSQL locks are released by COMMIT/ROLLBACK, not by
    # a pooled connection's lifetime. JSON framing avoids ambiguous project/UUID keys.
    identity = ["memoia:user-identity:v1", project_id, str(UUID(str(user_id)))]
    digest = hashlib.sha256(json.dumps(identity, ensure_ascii=False, separators=(",", ":")).encode()).digest()
    key = int.from_bytes(digest[:8], "big", signed=True)
    if not wait:
        return session.scalar(text("SELECT pg_try_advisory_xact_lock(:key)"), {"key": key})
    session.execute(text("SELECT pg_advisory_xact_lock(:key)"), {"key": key})


def assert_user_active(session, user_id, project_id):
    lock_user_identity(session, user_id, project_id)
    if session.execute(select(tombstones.c.user_id).where(
        _scope(tombstones, user_id, project_id),
    )).scalar_one_or_none() is not None:
        raise SourceError("user_forgotten", "User identity was permanently forgotten", 410, False)


def forget_user(user_id, project_id):
    with Session.begin() as session:
        # Permanent forgetting preempts model computation instead of waiting on its
        # renewable Redis lease. The same SQL identity lock linearizes all commits.
        session.info["memoia_fence_done"] = True
        lock_user_identity(session, user_id, project_id)
        session.execute(insert(tombstones).values(user_id=user_id, project_id=project_id)
                        .on_conflict_do_nothing(index_elements=["project_id", "user_id"]))
        session.execute(delete(User).where(User.id == user_id, User.project_id == project_id))
    return ForgottenUser(user_id=user_id, forgotten=True)


def _operation(row):
    from .maintenance import progress
    return Operation(
        operation_id=row["id"], kind=row["kind"], status=row["status"], source_id=row["source_id"],
        blob_id=row["blob_id"], result=row["result"], error=row["error"],
        flush=progress(row) if row["kind"] == "flush" else None,
    )


def validate_budget(prompt: str, system: str, *, source_text: str | None = None):
    if source_text is not None and len(get_encoded_tokens(source_text)) > CONFIG.source_max_input_tokens:
        raise SourceError("input_too_long", "Complete source exceeds input limit", 413)
    budget = len(get_encoded_tokens(prompt + system)) + CONFIG.source_output_reserve_tokens
    if budget > CONFIG.source_context_window_tokens:
        raise SourceError("input_too_long", "Prompt, evidence and reserved output exceed model budget", 413)


def retained_groups(groups, retracted):
    withdrawn = set(retracted)
    return [group for group in groups if not withdrawn.intersection(group)]


def evidence_time(groups, messages):
    """Latest supporting message recording time, never the event occurrence date."""
    times = {m["message_id"]: m["occurred_at"] for m in messages}
    return max(datetime.fromisoformat(times[mid]) if isinstance(times[mid], str) else times[mid]
               for group in groups for mid in group)


async def _structured(model, prompt, system, *, project_id=DEFAULT_PROJECT_ID,
                      llm_model=None, reasoning_effort=None, kind="fact_extraction"):
    validate_budget(prompt, system)
    schema = model.model_json_schema()
    # OpenAI strict schemas require all object keys; Pydantic fields here have no defaults.
    try:
        raw = await openai_complete(
            llm_model or CONFIG.best_llm_model, prompt, system_prompt=system,
            reasoning={"effort": reasoning_effort or CONFIG.llm_reasoning_effort, "mode": "standard"},
            service_tier="default",
            cache_fixed_prompt=True,
            on_usage=partial(record_completion_usage, project_id, kind=kind),
            max_output_tokens=CONFIG.source_output_reserve_tokens,
            text={"verbosity": "low", "format": {"type": "json_schema", "name": model.__name__, "strict": True, "schema": schema}},
        )
    except (BadRequestError, AuthenticationError, PermissionDeniedError, NotFoundError) as error:
        raise SourceError("model_configuration_rejected", "Model configuration or credentials were rejected", 503, False) from error
    except Exception as error:
        # Never return model/provider bodies, prompts or raw validation input in a response.
        raise SourceError("model_unavailable", "Model did not return a valid complete result", 503, True) from error
    try:
        return model.model_validate_json(raw)
    except ValueError as error:
        raise SourceError("invalid_model_output", "Model result does not match the required structure", 502, True) from error


def _project_rules(session, project_id):
    from ..prompts import user_profile_topics, zh_user_profile_topics
    from ..prompts.profile_init_utils import read_out_profile_config
    project = session.query(Project.profile_config).filter_by(project_id=project_id).one()
    config = ProfileConfig.load_config_string(project.profile_config or "")
    language = config.language or CONFIG.language
    defaults = user_profile_topics if language == "en" else zh_user_profile_topics
    topics = read_out_profile_config(config, defaults.CANDIDATE_PROFILE_TOPICS)
    return {
        "llm_model": config.llm_model or CONFIG.best_llm_model,
        "reasoning_effort": config.reasoning_effort or CONFIG.llm_reasoning_effort,
        "language": language,
        "profile_topics": [{"topic": p.topic, "description": p.description,
                            "sub_topics": [s.model_dump() for s in p.sub_topics]}
                           for p in topics],
        "event_tag_definitions": config.event_tags if config.event_tags is not None else CONFIG.event_tags,
    }


async def extract_source(request: ImportSource, *, rules=None, project_id=DEFAULT_PROJECT_ID,
                         candidate=None, save_candidate=None):
    data = [m.model_dump(mode="json", exclude={"time_zone"}) for m in request.messages]
    from zoneinfo import ZoneInfo
    for message, original in zip(data, request.messages, strict=True):
        local = original.occurred_at.astimezone(ZoneInfo(original.time_zone)) if original.time_zone else None
        message["local_recorded_date"] = local.date().isoformat() if local else None
    rules = rules or {}
    from ..prompts.assembly import reference_data
    prompt = reference_data("source_material", {"messages": data})
    validate_budget(prompt, EXTRACT_SYSTEM, source_text="\n".join(m.content for m in request.messages))
    if candidate is not None:
        try:
            result = Extraction.model_validate(candidate)
        except ValueError as error:
            # The retired two-step draft has no evidence. Re-extract from this
            # still-valid original input, never manufacture links for its text.
            content_fields = {"content", "subject", "reporter", "certainty"}
            legacy_draft = (isinstance(candidate, dict) and set(candidate) == {"facts"}
                            and isinstance(candidate["facts"], list) and bool(candidate["facts"])
                            and all(isinstance(item, dict) and set(item) == content_fields
                                    for item in candidate["facts"]))
            if not legacy_draft:
                raise SourceError("invalid_model_output", "Saved Fact candidate is invalid", 502, True) from error
        else:
            return _validated_extraction(result, request, data)
    response = await _structured(MessageExtraction, prompt, EXTRACT_SYSTEM, project_id=project_id,
                                llm_model=rules.get("llm_model"), reasoning_effort=rules.get("reasoning_effort"))
    result = _normalize_extraction(response, request)
    extracted = _validated_extraction(result, request, data)
    if save_candidate is not None:
        await save_candidate(result.model_dump(mode="json"))
    return extracted


def _validate_evidence_references(result, request):
    """Keep evidence references within this batch; this is not semantic proof."""
    ids = {m.message_id: m for m in request.messages}
    for fact in result.facts:
        for group in fact.support_groups:
            if not set(group).issubset(ids) or not any(ids[mid].role == "user" for mid in group):
                raise SourceError("invalid_model_output", "Fact evidence must reference supplied user evidence", 502, True)
        if fact.fact_time is not None:
            for item in fact.fact_time.evidence:
                if item.message_id not in ids or item.expression not in ids[item.message_id].content:
                    raise SourceError("invalid_model_output", "Time expression must cite an original source message", 502, True)


def _validated_extraction(result, request, data):
    """Validate assembled evidence and time before producing formal facts."""
    _validate_evidence_references(result, request)
    output = []
    for fact in result.facts:
        occurred_at = evidence_time(fact.support_groups, data)
        value = fact.model_dump(mode="json")
        if fact.fact_time is not None and supported_fact_time(value["fact_time"], fact.support_groups) is None:
            raise SourceError("invalid_model_output", "Time evidence must be jointly supported by fact evidence", 502, True)
        output.append({"id": uuid4(), **value, "occurred_at": occurred_at})
    return ExtractedSource(output)


def _fence_snapshot(session, user_id, project_id, lease):
    assert_user_active(session, user_id, project_id)
    session.info["memoia_fence_done"] = True
    session.execute(insert(states).values(user_id=user_id, project_id=project_id).on_conflict_do_nothing())
    row = session.execute(update(states).where(_identity(user_id, project_id))
                          .values(generation=states.c.generation + 1)
                          .returning(states.c.generation, states.c.version)).one()
    lease.generation, lease.version = row


def fence_commit(session, user_id, project_id, lease):
    assert_user_active(session, user_id, project_id)
    session.info["memoia_fence_done"] = True
    lease.assert_owned()
    result = session.execute(update(states).where(
        _identity(user_id, project_id), states.c.generation == lease.generation,
        states.c.version == lease.version,
    ).values(version=states.c.version + 1).returning(states.c.version)).scalar_one_or_none()
    if result is None:
        raise SourceError("write_conflict", "Memory changed while the result was computed", 409, True)
    # Advance the snapshot only after COMMIT succeeds, never on rolled-back SQL.
    session.info["memoia_committed_version"] = (lease, result)




def _profile_snapshot(session, user_id, project_id):
    from .derived_impact import IMPACT_KEY
    return [{"id": str(p.id), "content": p.content, "topic": p.attributes.get("topic", ""),
             "sub_topic": p.attributes.get("sub_topic", ""),
             "fact_ids": sorted(p.attributes.get("fact_ids", [])),
             "source_ids": sorted(p.attributes.get("source_ids", [])),
             IMPACT_KEY: p.attributes.get(IMPACT_KEY)}
            for p in session.query(UserProfile).filter(UserProfile.user_id == user_id,
               UserProfile.project_id == project_id, UserProfile.attributes.contains({"memoia_v2": True}))
            .order_by(UserProfile.id).all()]




def _history_profiles(profiles, changed_fact_ids):
    from .derived_impact import history_survives
    return [profile for profile in profiles if history_survives(profile, changed_fact_ids)]


def _scrub_history(session, user_id, project_id, changed_fact_ids):
    from .derived_impact import IMPACT_KEY
    if not changed_fact_ids:
        return
    affected = or_(*(
        revisions.c[field].contains([{key: [ident]}])
        for field in ("profiles", "added", "removed")
        for key in ("fact_ids", IMPACT_KEY) for ident in changed_fact_ids), *(
        func.jsonb_path_exists(revisions.c[field],
            f'$[*] ? (! (exists (@.{IMPACT_KEY})) || @.{IMPACT_KEY} == null)')
        for field in ("profiles", "added", "removed")))
    for row in session.execute(select(revisions).where(_scope(revisions, user_id, project_id), affected)).mappings():
        # Current derived text may lag, but withdrawn evidence is not a history fallback.
        cleaned = {field: _history_profiles(row[field], changed_fact_ids)
                   for field in ("profiles", "added", "removed")}
        session.execute(update(revisions).where(revisions.c.id == row["id"]).values(**cleaned))


def get_history(user_id, project_id, limit=50, offset=0):
    from .derived_impact import IMPACT_KEY, public_data
    with Session() as session:
        rows = session.execute(select(revisions).where(_scope(revisions, user_id, project_id))
                               .order_by(revisions.c.created_at, revisions.c.id).limit(limit).offset(offset)).mappings().all()
        referenced = {fid for row in rows for field in ("profiles", "added", "removed")
                      for profile in row[field]
                      for fid in {*profile["fact_ids"], *(profile.get(IMPACT_KEY) or [])}}
        valid = {str(fid) for fid in session.scalars(select(facts.c.id).where(
            _scope(facts, user_id, project_id), facts.c.id.in_(referenced)))} if referenced else set()
        # The read filter also protects against maintenance removal outside the retract path.
        return [HistoryEntry(revision_id=row["id"], operation_id=row["operation_id"], source_id=row["source_id"],
                 maintenance_version=row["maintenance_version"],
                 created_at=row["created_at"], **{field: [public_data(p) for p in row[field]
                     if p.get(IMPACT_KEY) is not None
                     and {*p["fact_ids"], *p[IMPACT_KEY]}.issubset(valid)]
                                                for field in ("profiles", "added", "removed")}) for row in rows]


async def _fact_vectors(project_id, source_facts):
    texts = [render_search_fact(f["content"], f.get("fact_time")) for f in source_facts]
    if not texts or not CONFIG.enable_event_embedding:
        return [None] * len(texts)
    result = await get_embedding(project_id, texts)
    if not result.ok():
        if result.code() == 400:
            raise SourceError("embedding_input_too_long", "Complete Fact exceeds embedding input limit", 413)
        if result.code() in {401, 403, 404, 422}:
            raise SourceError("embedding_configuration_rejected", "Embedding configuration or credentials were rejected", 503)
        raise SourceError("embedding_unavailable", "Embedding generation failed", 503, True)
    return list(result.data())




def _register(user_id, project_id, key, kind, request, source_id, *, legacy_buffers=None):
    request_hash = _hash({"kind": kind, "request": request})
    with Session.begin() as session:
        assert_user_active(session, user_id, project_id)
        if kind in {"import", "retract"}:
            # The authenticated project owns this UUID; first imports and concurrent
            # accepted receipts create it in this same transaction, not a v1 preflight.
            session.execute(insert(User.__table__).values(id=user_id, project_id=project_id, additional_fields={})
                            .on_conflict_do_nothing(index_elements=["id", "project_id"]))
        session.execute(insert(sources).values(user_id=user_id, project_id=project_id, source_id=source_id,
                                               legacy=source_id.startswith("v1-flush:"))
                        .on_conflict_do_nothing())
        previous = session.execute(select(operations).where(_scope(operations, user_id, project_id),
            operations.c.idempotency_key == key)).mappings().one_or_none()
        if previous and previous["request_hash"] != request_hash:
            raise SourceError("idempotency_conflict", "Idempotency key was used for a different request", 409)
        if kind == "import" and (not previous or previous["status"] != "completed"):
            _accept_messages(session, user_id, project_id, ImportSource.model_validate(request))
        blob_id = previous["blob_id"] if previous else None
        if kind in {"import", "retract"} and not previous:
            blob_id = uuid4()
            session.execute(insert(blobs).values(id=blob_id, user_id=user_id, project_id=project_id,
                source_id=source_id, kind=kind,
                message_ids=[m["message_id"] for m in request["messages"]] if kind == "import" else request["message_ids"],
                status="active" if kind == "import" else "retracted"))
            if kind == "retract":
                # Fixed deletion batches can reference unknown messages. Their
                # body-free tombstones also make Blob membership valid.
                for mid in request["message_ids"]:
                    session.execute(insert(messages).values(user_id=user_id, project_id=project_id,
                        source_id=source_id, message_id=mid, deleted=True).on_conflict_do_nothing())
        stored_request = dict(request)
        if legacy_buffers:
            # Server-owned cleanup identities are durable, but are not part of the
            # public input/hash. Recovery must commit cleanup with the original receipt.
            stored_request["legacy_buffers"] = {
                "buffer_ids": [str(value) for value in legacy_buffers[0]],
                "blob_ids": [str(value) for value in legacy_buffers[1]],
            }
            if previous and previous["status"] != "completed" and "legacy_buffers" not in previous["request"]:
                # A v1 flush can attach missing cleanup proof to its already accepted
                # original operation; never change its public hash or established proof.
                session.execute(update(operations).where(operations.c.id == previous["id"])
                    .values(request={**previous["request"], "legacy_buffers": stored_request["legacy_buffers"]}))
        if (kind == "import" and previous and not _can_process(previous)
                and _can_process(previous, explicit_retry=True)):
            now = datetime.now(timezone.utc)
            if not previous["input_expires_at"] or previous["input_expires_at"] <= now:
                # Restore only the same batch's temporary input. Its failed receipt
                # stays unchanged until the caller explicitly retries that operation.
                if "legacy_buffers" in previous["request"]:
                    stored_request["legacy_buffers"] = previous["request"]["legacy_buffers"]
                session.execute(update(operations).where(operations.c.id == previous["id"])
                    .values(request=stored_request, input_expires_at=now + timedelta(
                        seconds=CONFIG.source_input_retention_seconds)))
        session.execute(insert(operations).values(
            id=uuid4(), user_id=user_id, project_id=project_id, idempotency_key=key,
            kind=kind, request_hash=request_hash, request=stored_request, source_id=source_id, blob_id=blob_id, status="processing",
            input_expires_at=datetime.now(timezone.utc) + timedelta(seconds=CONFIG.source_input_retention_seconds)
                if kind == "import" else None,
        ).on_conflict_do_nothing(index_elements=["user_id", "project_id", "idempotency_key"]))
        row = dict(session.execute(select(operations).where(
            _scope(operations, user_id, project_id), operations.c.idempotency_key == key,
        )).mappings().one())
        if row["request_hash"] != request_hash:
            raise SourceError("idempotency_conflict", "Idempotency key was used for a different request", 409)
    return row


def get_operation(user_id, project_id, *, operation_id=None, key=None):
    with Session() as session:
        condition = operations.c.id == operation_id if operation_id is not None else operations.c.idempotency_key == key
        row = session.execute(select(operations).where(_scope(operations, user_id, project_id), condition)).mappings().one_or_none()
        if row is None:
            raise SourceError("operation_not_found", "Operation not found", 404)
        return _operation(row)


def _set_failure(user_id, project_id, op, lease, error):
    # A successful COMMIT whose acknowledgement was lost must never become failed.
    # Correction expiry may already have published its final input_required receipt.
    unfinished = (operations.c.status == "processing" if op["kind"] == "correct"
                  else operations.c.status != "completed")
    with Session.begin() as session:
        session.info["memoia_fence_done"] = True
        session.execute(update(operations).where(
            operations.c.id == op["id"], _scope(operations, user_id, project_id),
            unfinished, operations.c.generation == lease.generation,
        ).values(status="failed", error={"code": error.code, "retryable": error.retryable}))


def _message_hash(message):
    # Preserve established message identities; optional zone evidence is validated separately.
    return _hash({"role": message.role, "content": message.content,
                  "occurred_at": message.occurred_at.astimezone(timezone.utc).isoformat()})


def _message_rows(session, user_id, project_id, source_id, message_ids):
    return [dict(row) for row in session.execute(select(messages).where(
        _scope(messages, user_id, project_id), messages.c.source_id == source_id,
        messages.c.message_id.in_(message_ids),
    )).mappings()]


def _accept_messages(session, user_id, project_id, request):
    known = {row["message_id"]: row for row in _message_rows(session, user_id, project_id,
        request.source_id, [message.message_id for message in request.messages])}
    for message in request.messages:
        row = known.get(message.message_id)
        digest = _message_hash(message)
        if row and row["content_hash"] and row["content_hash"] != digest:
            raise SourceError("message_conflict", "Message identity has different content, role or recording time", 409)
        if row and message.time_zone is not None:
            if row["time_zone"] is not None and row["time_zone"] != message.time_zone:
                raise SourceError("message_conflict", "Message identity has different recorded timezone", 409)
            if row["time_zone"] is None:
                # Enrich only from a supplied original; this never rewrites old event dates.
                session.execute(update(messages).where(_scope(messages, user_id, project_id),
                    messages.c.source_id == request.source_id, messages.c.message_id == message.message_id)
                    .values(time_zone=message.time_zone))
        if not row:
            session.execute(insert(messages).values(user_id=user_id, project_id=project_id,
                source_id=request.source_id, message_id=message.message_id, content_hash=digest,
                role=message.role, occurred_at=message.occurred_at, time_zone=message.time_zone))
    return known


def _expire_correction_inputs(now):
    # Interrupted work must require explicit retry even after its input is restored.
    return update(operations).where(operations.c.kind == "correct", operations.c.status != "completed",
        or_(operations.c.input_expires_at <= now,
            and_(operations.c.input_expires_at.is_(None), operations.c.status == "processing"))).values(
        request=operations.c.request.op("-")("content").op("-")("subject").op("-")("reporter")
            .op("-")("certainty").op("-")("support_groups").op("-")("fact_time"),
        input_expires_at=None,
        status=case((operations.c.status == "processing", "failed"), else_=operations.c.status),
        error=case((operations.c.status == "processing",
                    func.jsonb_build_object("code", "input_required", "retryable", False)),
                   else_=operations.c.error))


def purge_expired_inputs():
    """One bounded-purpose sweep, not a second task/processing scheduler."""
    with Session.begin() as session:
        session.info["memoia_fence_done"] = True
        session.execute(update(operations).where(operations.c.kind == "import",
            operations.c.input_expires_at <= func.now()).values(
                request=func.jsonb_build_object("source_id", operations.c.source_id,
                    "idempotency_key", operations.c.idempotency_key),
                input_expires_at=None))
        session.execute(_expire_correction_inputs(func.now()))
        from ..models.database import GeneralBlob
        session.execute(delete(GeneralBlob).where(GeneralBlob.blob_type == "chat",
            GeneralBlob.created_at < datetime.now(timezone.utc) - timedelta(seconds=CONFIG.source_input_retention_seconds)))


def _can_process(operation, *, explicit_retry=False):
    if operation["status"] == "completed":
        return False
    if operation["status"] != "failed":
        return True
    error = operation["error"]
    if error["retryable"]:
        return True
    # Retired history limits can be resumed only by an explicit request. Preserve
    # their original failed receipts until then; never migrate them into auto-retry.
    return explicit_retry and (error["code"] in {"reconciliation_too_large", "related_facts_too_large"}
                              or operation["kind"] == "correct" and error["code"] == "input_required")


async def import_source(user_id, project_id, request: ImportSource, *, legacy_buffers=None, explicit_retry=False):
    payload = request.model_dump(mode="json")
    # Omitted timezone keeps the pre-extension request fingerprint stable.
    for message in payload["messages"]:
        if message.get("time_zone") is None:
            message.pop("time_zone", None)
    op = await run_sql(_register, user_id, project_id, request.idempotency_key, "import", payload,
                       request.source_id, legacy_buffers=legacy_buffers)
    if not _can_process(op, explicit_retry=explicit_retry):
        return _operation(op)

    def snapshot(lease):
        with Session.begin() as session:
            assert_user_active(session, user_id, project_id)
            current = session.execute(select(operations).where(operations.c.id == op["id"])).mappings().one()
            if not _can_process(current, explicit_retry=explicit_retry):
                return _operation(current)
            _fence_snapshot(session, user_id, project_id, lease)
            cleanup = current["request"].get("legacy_buffers")
            legacy_group = session.scalar(select(sources.c.legacy).where(
                _scope(sources, user_id, project_id), sources.c.source_id == request.source_id))
            if cleanup is None and legacy_group and request.source_id.startswith("legacy:") \
                    and request.idempotency_key.startswith("v1-flush:"):
                # Adopt only this pending receipt's original synthetic identities.
                from ..models.database import BufferZone
                raw_ids = []
                for message in request.messages:
                    try:
                        raw_ids.append(UUID(message.message_id.split(":", 1)[0]))
                    except ValueError:
                        continue
                old = session.query(BufferZone).filter(BufferZone.user_id == user_id,
                    BufferZone.project_id == project_id, BufferZone.blob_type == "chat",
                    BufferZone.blob_id.in_(raw_ids)).all()
                if old:
                    cleanup = {"buffer_ids": [str(row.id) for row in old],
                               "blob_ids": sorted({str(row.blob_id) for row in old})}
            known = _accept_messages(session, user_id, project_id, request)
            deleted = {mid for mid, row in known.items() if row["deleted"]}
            new_ids = {m.message_id for m in request.messages if m.message_id not in deleted
                       and not known.get(m.message_id, {}).get("processed", False)}
            rules = _project_rules(session, project_id) if new_ids else None
            # Deleted/processed membership is part of the effective input identity.
            # A retry after retraction cannot reuse an earlier batch's conclusions.
            fingerprint = _hash({"messages": [m.model_dump(mode="json") for m in request.messages
                                              if m.message_id not in deleted], "new_ids": sorted(new_ids)})
            candidate = current["request"].get(_EXTRACTION_CANDIDATE)
            now = datetime.now(timezone.utc)
            input_valid = current["input_expires_at"] and current["input_expires_at"] > now
            if not input_valid or not candidate or candidate["input_fingerprint"] != fingerprint:
                candidate = None
            stored_payload = {**payload, **({"legacy_buffers": cleanup} if cleanup else {}),
                              **({_EXTRACTION_CANDIDATE: candidate} if candidate else {})}
            session.execute(update(operations).where(operations.c.id == op["id"])
                            .values(generation=lease.generation, status="processing", error=None,
                                request=stored_payload, input_expires_at=current["input_expires_at"]
                                    if input_valid else now + timedelta(seconds=CONFIG.source_input_retention_seconds)))
        return cleanup, deleted, new_ids, rules, fingerprint, candidate

    def save_candidate(lease, fingerprint, extraction):
        # Candidate durability must not advance the formal memory version. The
        # same short identity lock and ownership checks still fence this write.
        with Session.begin() as session:
            assert_user_active(session, user_id, project_id)
            session.info["memoia_fence_done"] = True
            lease.assert_owned()
            current_state = session.execute(select(states.c.generation, states.c.version).where(
                _identity(user_id, project_id))).one()
            if tuple(current_state) != (lease.generation, lease.version):
                raise SourceError("write_conflict", "Memory changed while the result was computed", 409, True)
            current = session.execute(select(operations).where(
                operations.c.id == op["id"], _scope(operations, user_id, project_id),
                operations.c.generation == lease.generation, operations.c.status == "processing",
            )).mappings().one_or_none()
            if current is None:
                raise SourceError("write_conflict", "Operation ownership changed while the result was computed", 409, True)
            if not current["input_expires_at"] or current["input_expires_at"] <= datetime.now(timezone.utc):
                raise SourceError("input_required", "Temporary source input expired", 409)
            saved = session.execute(update(operations).where(operations.c.id == op["id"],
                operations.c.input_expires_at > func.now())
                .values(request={**current["request"], _EXTRACTION_CANDIDATE: {
                    "input_fingerprint": fingerprint, "extraction": extraction,
                }}).returning(operations.c.id)).scalar_one_or_none()
            if saved is None:
                raise SourceError("input_required", "Temporary source input expired", 409)

    def commit(lease, cleanup, active, new_ids, new_facts, vectors):
        blob_id = op["blob_id"]
        with Session.begin() as session:
            fence_commit(session, user_id, project_id, lease)
            commit_version = session.info["memoia_committed_version"][1]
            changed = []
            for fact, vector in zip(new_facts, vectors, strict=True):
                values = {**fact, "blob_id": blob_id, "user_id": user_id, "project_id": project_id,
                    "search_text": render_search_fact(fact["content"], fact.get("fact_time")),
                    "embedding": vector, "created_version": commit_version}
                session.execute(insert(facts).values(**values))
                changed.append({"fact_id": str(fact["id"]), "kind": "added"})
            session.execute(update(messages).where(_scope(messages, user_id, project_id),
                messages.c.source_id == request.source_id, messages.c.message_id.in_(new_ids)).values(processed=True))
            session.execute(update(blobs).where(blobs.c.id == blob_id).values(
                status="retracted" if not active.messages else "active"))
            result = {"event_ids": [], "profile_ids": [], "fact_ids": [str(f["id"]) for f in new_facts],
                      "memory_version": commit_version}
            from .maintenance import record_changes
            record_changes(session, user_id, project_id, blob_id, commit_version, changed)
            session.execute(update(operations).where(operations.c.id == op["id"])
                            .values(status="completed", blob_id=blob_id, result=result, error=None,
                                request=func.jsonb_build_object("source_id", request.source_id,
                                    "idempotency_key", request.idempotency_key),
                                input_expires_at=None))
            if cleanup:
                from ..models.database import BufferZone, GeneralBlob
                session.execute(update(BufferZone).where(BufferZone.id.in_(cleanup["buffer_ids"]),
                                BufferZone.user_id == user_id, BufferZone.project_id == project_id).values(status="done"))
                session.execute(delete(GeneralBlob).where(GeneralBlob.id.in_(cleanup["blob_ids"]),
                                GeneralBlob.user_id == user_id, GeneralBlob.project_id == project_id,
                                GeneralBlob.blob_type == "chat"))
        return get_operation(user_id, project_id, operation_id=op["id"])

    try:
        async with UserLease(str(user_id), project_id) as lease:
            try:
                state = await run_sql(snapshot, lease)
                if isinstance(state, Operation):
                    return state
                cleanup, deleted, new_ids, rules, fingerprint, candidate = state
                # Repeated messages may provide context for new statements, but are
                # never accepted as a second independent evidence occurrence.
                active = request.model_copy(update={"messages": [m for m in request.messages if m.message_id not in deleted]})
                if new_ids:
                    validate_budget(json.dumps(payload, ensure_ascii=False), EXTRACT_SYSTEM,
                                    source_text="\n".join(m.content for m in active.messages))
                async def persist_candidate(extraction):
                    await run_sql(save_candidate, lease, fingerprint, extraction)
                extracted = await extract_source(active, rules=rules, project_id=project_id,
                    candidate=candidate["extraction"] if candidate else None,
                    save_candidate=persist_candidate) if new_ids else ExtractedSource([])
                new_facts = extracted.facts
                for fact in new_facts:
                    fact["support_groups"] = [g for g in fact["support_groups"] if new_ids.intersection(g)]
                new_facts = [f for f in new_facts if f["support_groups"]]
                for fact in new_facts:
                    fact["occurred_at"] = evidence_time(fact["support_groups"], payload["messages"])
                    fact["fact_time"] = supported_fact_time(fact.get("fact_time"), fact["support_groups"])
                lease.assert_owned()
                vectors = await _fact_vectors(project_id, new_facts)
                return await run_sql(commit, lease, cleanup, active, new_ids, new_facts, vectors)
            except (SourceError, LeaseLost) as error:
                if isinstance(error, LeaseLost):
                    error = SourceError("lease_lost", "Processing ownership was lost", 409, True)
                await run_sql(_set_failure, user_id, project_id, op, lease, error)
                raise error
    except LeaseUnavailable:
        return await run_sql(get_operation, user_id, project_id, operation_id=op["id"])


async def retry_operation(user_id, project_id, operation_id):
    def read_operation():
        with Session() as session:
            assert_user_active(session, user_id, project_id)
            row = session.execute(select(operations).where(_scope(operations, user_id, project_id),
                                                           operations.c.id == operation_id)).mappings().one_or_none()
            if row is None:
                raise SourceError("operation_not_found", "Operation not found", 404)
            return dict(row)
    op = await run_sql(read_operation)
    if op["kind"] == "flush":
        from .maintenance import retry_flush
        return await run_sql(retry_flush, user_id, project_id, operation_id)
    if not _can_process(op, explicit_retry=True):
        return _operation(op)
    # The processing functions acquire a lease and increment SQL generation before reuse.
    # An old model request may still run, but its effect cannot commit after takeover.
    if op["kind"] == "import":
        if not op["input_expires_at"] or op["input_expires_at"] <= datetime.now(timezone.utc):
            await run_sql(purge_expired_inputs)
            raise SourceError("input_required", "Temporary input expired; query the receipt before resupplying the same batch and key", 409)
        body = {key: value for key, value in op["request"].items()
                if key not in {"legacy_buffers", _EXTRACTION_CANDIDATE}}
        return await import_source(user_id, project_id, ImportSource.model_validate(body), explicit_retry=True)
    if op["kind"] == "correct":
        if not op["input_expires_at"] or op["input_expires_at"] <= datetime.now(timezone.utc):
            await run_sql(purge_expired_inputs)
            raise SourceError("input_required", "Temporary correction input expired; resupply the original request and key", 409)
        action = op["request"]["action"]
        body = {k: v for k, v in op["request"].items() if k not in {"action", "fact_id", "source_id"}}
        if action == "update":
            return await update_fact(user_id, project_id, UUID(op["request"]["fact_id"]),
                                     UpdateFact.model_validate(body), explicit_retry=True)
        if action == "delete":
            return await delete_fact(user_id, project_id, UUID(op["request"]["fact_id"]),
                                     DeleteFact.model_validate(body), explicit_retry=True)
        raise SourceError("operation_kind_unsupported", "Correction action cannot be retried", 409)
    if op["kind"] == "retract":
        return await delete_messages(user_id, project_id, op["source_id"], DeleteMessages.model_validate({
            k: op["request"][k] for k in ("idempotency_key", "message_ids")
        }), explicit_retry=True)
    raise SourceError("operation_kind_unsupported", "Operation kind cannot be retried", 409)


def _blob(row, session=None, event_ids=None):
    row = dict(row)
    if row.get("flush_id"):
        from .maintenance import progress
        row["flush_progress"] = progress({key: row["flush_" + key] for key in (
            "id", "request", "status", "lease_until", "attempts", "available_at", "error")})
    operation_status = row["operation_status"]
    status = operation_status if operation_status in {"processing", "failed"} else row["status"]
    resolved = set(event_ids or []) if status not in {"processing", "failed", "rebuilding"} else set()
    if event_ids is None and session is not None and status not in {"processing", "failed", "rebuilding"}:
        resolved.update(session.scalars(select(event_facts.c.event_id).join(facts, facts.c.id == event_facts.c.fact_id).where(
            _scope(event_facts, row["user_id"], row["project_id"]), facts.c.blob_id == row["id"])))
    if event_ids is None and row["event_id"] and not row["event_deleted"] and status not in {"processing", "failed", "rebuilding"}:
        if session is not None and session.scalar(select(UserEvent.id).where(
                UserEvent.id == row["event_id"], UserEvent.user_id == row["user_id"],
                UserEvent.project_id == row["project_id"])) is not None:
            resolved.add(row["event_id"])
    return Blob(blob_id=row["id"], source_id=row["source_id"], status=status,
        message_ids=row["message_ids"], event_ids=sorted(resolved, key=str), created_at=row["created_at"],
        kind=row["kind"], flush=row.get("flush_progress"))


def _blob_event_ids(session, rows):
    """Resolve a bounded page in one query, including surviving legacy parents."""
    from sqlalchemy import union_all, exists
    ids = {row["id"] for row in rows}
    if not ids:
        return {}
    uid, pid = rows[0]["user_id"], rows[0]["project_id"]
    current = select(facts.c.blob_id, event_facts.c.event_id).join(event_facts,
        and_(event_facts.c.fact_id == facts.c.id, event_facts.c.user_id == facts.c.user_id,
             event_facts.c.project_id == facts.c.project_id)).where(
        _scope(facts, uid, pid), facts.c.blob_id.in_(ids))
    legacy = select(blobs.c.id.label("blob_id"), blobs.c.event_id).where(
        _scope(blobs, uid, pid), blobs.c.id.in_(ids), ~blobs.c.event_deleted,
        exists(select(UserEvent.id).where(UserEvent.id == blobs.c.event_id,
            UserEvent.user_id == uid, UserEvent.project_id == pid)))
    resolved = {}
    for blob_id, event_id in session.execute(union_all(current, legacy)):
        resolved.setdefault(blob_id, set()).add(event_id)
    return resolved


def _blob_query(user_id, project_id):
    # The unique canonical import/Blob constraint makes this a one-row join.
    flush_operation = operations.alias("flush_operation")
    return select(blobs, operations.c.status.label("operation_status"),
        *[flush_operation.c[key].label("flush_" + key) for key in (
            "id", "request", "status", "lease_until", "attempts", "available_at", "error")]
    ).outerjoin(
        operations, and_(operations.c.blob_id == blobs.c.id, operations.c.kind.in_(["import", "retract", "correct"]))
    ).outerjoin(flush_operation, flush_operation.c.id == blobs.c.flush_operation_id
    ).where(_scope(blobs, user_id, project_id))


def get_blob(user_id, project_id, blob_id):
    with Session() as session:
        row = session.execute(_blob_query(user_id, project_id).where(
            blobs.c.id == blob_id)).mappings().one_or_none()
        if row is None:
            raise SourceError("blob_not_found", "Blob not found", 404)
        return _blob(row, session)


def _source(session, row, limit, message_offset, blob_offset, evidence_offset):
    uid, pid, sid = row["user_id"], row["project_id"], row["source_id"]
    member_messages = session.execute(select(messages).where(_scope(messages, uid, pid),
        messages.c.source_id == sid).order_by(messages.c.message_id)
        .limit(limit + 1).offset(message_offset)).mappings().all()
    batches = session.execute(_blob_query(uid, pid).where(blobs.c.source_id == sid)
        .order_by(blobs.c.created_at, blobs.c.id).limit(limit + 1).offset(blob_offset)).mappings().all()
    fact_rows = session.execute(select(facts).join(blobs, facts.c.blob_id == blobs.c.id).where(
        _scope(facts, uid, pid), blobs.c.source_id == sid).order_by(facts.c.occurred_at, facts.c.id)
        .limit(limit + 1).offset(evidence_offset)).mappings().all()
    # Evidence observations must not be restricted to the independently paged
    # message list, nor require reading every historical message in this Source.
    support_ids = {mid for f in fact_rows[:limit] for group in f["support_groups"] for mid in group}
    observations = session.execute(select(messages).where(_scope(messages, uid, pid),
        messages.c.source_id == sid, messages.c.message_id.in_(support_ids))).mappings().all() if support_ids else []
    batch_events = _blob_event_ids(session, batches[:limit])
    return Source(source_id=sid, legacy=row["legacy"],
        message_ids=[m["message_id"] for m in member_messages[:limit]],
        deleted_message_ids=[m["message_id"] for m in member_messages[:limit] if m["deleted"]],
        created_at=row["created_at"], blobs=[_blob(b, event_ids=batch_events.get(b["id"], set())) for b in batches[:limit]],
        next_message_offset=message_offset + limit if len(member_messages) > limit else None,
        next_blob_offset=blob_offset + limit if len(batches) > limit else None,
        next_evidence_offset=evidence_offset + limit if len(fact_rows) > limit else None,
        evidence=[Evidence(fact_id=f["id"], blob_id=f["blob_id"], content=f["content"], topic=f["topic"],
                           sub_topic=f["sub_topic"], support_groups=f["support_groups"], fact_time=f["fact_time"],
                           subject=f["subject"], reporter=f["reporter"], certainty=f["certainty"], revision=f["revision"],
                           created_at=f["created_at"], updated_at=f["updated_at"],
                           source_messages=source_observations(f["support_groups"], observations)) for f in fact_rows[:limit]])


def get_source(user_id, project_id, *, source_id, limit=50, message_offset=0, blob_offset=0, evidence_offset=0):
    if not 1 <= limit <= 100 or min(message_offset, blob_offset, evidence_offset) < 0:
        raise SourceError("invalid_pagination", "Invalid source page", 400)
    with Session() as session:
        row = session.execute(select(sources).where(_scope(sources, user_id, project_id),
                                                    sources.c.source_id == source_id)).mappings().one_or_none()
        if row is None:
            raise SourceError("source_not_found", "Source not found", 404)
        return _source(session, row, limit, message_offset, blob_offset, evidence_offset)


def list_sources(user_id, project_id, limit=50, offset=0):
    with Session() as session:
        rows = session.execute(select(sources).where(_scope(sources, user_id, project_id))
                               .order_by(sources.c.created_at, sources.c.source_id).limit(limit).offset(offset)).mappings().all()
        return [SourceSummary(source_id=row["source_id"], legacy=row["legacy"], created_at=row["created_at"])
                for row in rows]


async def delete_messages(user_id, project_id, source_id, request: DeleteMessages, *, explicit_retry=False):
    payload = {"source_id": str(source_id), **request.model_dump(mode="json")}
    op = await run_sql(_register, user_id, project_id, request.idempotency_key, "retract", payload, source_id)
    if not _can_process(op, explicit_retry=explicit_retry):
        return _operation(op)

    def snapshot(lease):
        with Session.begin() as session:
            assert_user_active(session, user_id, project_id)
            current = session.execute(select(operations).where(operations.c.id == op["id"])).mappings().one()
            if not _can_process(current, explicit_retry=explicit_retry):
                return _operation(current)
            _fence_snapshot(session, user_id, project_id, lease)
            # A message can occur in multiple batches. Restrict by the fixed input
            # membership first, then fetch only facts whose support really changes.
            affected_blobs = [dict(row) for row in session.execute(select(blobs.c.id, blobs.c.message_ids).where(
                _scope(blobs, user_id, project_id), blobs.c.source_id == source_id,
                blobs.c.message_ids.has_any(array(request.message_ids)))).mappings()]
            changed_facts = [dict(row) for row in session.execute(select(facts).where(
                _scope(facts, user_id, project_id), facts.c.blob_id.in_([blob["id"] for blob in affected_blobs]),
                or_(*(facts.c.support_groups.contains([[mid]]) for mid in request.message_ids)))).mappings()]
            needed_ids = {mid for blob in affected_blobs for mid in blob["message_ids"]}
            message_rows = _message_rows(session, user_id, project_id, source_id, needed_ids)
            session.execute(update(operations).where(operations.c.id == op["id"])
                            .values(status="processing", generation=lease.generation, error=None))
        return affected_blobs, changed_facts, message_rows

    def commit(lease, affected_blobs, changed_facts, withdrawn, surviving, removed):
        with Session.begin() as session:
            fence_commit(session, user_id, project_id, lease)
            commit_version = session.info["memoia_committed_version"][1]
            for mid in request.message_ids:
                session.execute(insert(messages).values(user_id=user_id, project_id=project_id,
                    source_id=source_id, message_id=mid, deleted=True).on_conflict_do_update(
                        index_elements=["user_id", "project_id", "source_id", "message_id"], set_={"deleted": True}))
            session.execute(delete(facts).where(_scope(facts, user_id, project_id), facts.c.id.in_(removed)))
            changed = [{"fact_id": str(fid), "kind": "deleted"} for fid in removed]
            for fact in surviving:
                session.execute(update(facts).where(_scope(facts, user_id, project_id), facts.c.id == fact["id"]).values(
                    support_groups=fact["support_groups"], occurred_at=fact["occurred_at"], fact_time=fact["fact_time"],
                    search_text=fact["search_text"], embedding=fact["embedding"], revision=facts.c.revision + 1,
                    updated_at=func.now()))
                changed.append({"fact_id": str(fact["id"]), "kind": "evidence"})
            _scrub_history(session, user_id, project_id, {c["fact_id"] for c in changed})
            # A zero-fact batch still owns inputs; retraction status describes that
            # fixed membership, independently of eventual derived-layer progress.
            for blob in affected_blobs:
                session.execute(update(blobs).where(_scope(blobs, user_id, project_id),
                    blobs.c.id == blob["id"]).values(status="retracted"
                        if set(blob["message_ids"]).issubset(withdrawn) else "active"))
            from .maintenance import record_changes
            record_changes(session, user_id, project_id, op["blob_id"], commit_version, changed)
            # Derived text may lag; readers must not return lost support as evidence.
            session.execute(update(operations).where(operations.c.id == op["id"])
                            .values(status="completed", result={"event_ids": [], "profile_ids": [],
                                "fact_ids": [str(f["id"]) for f in changed_facts], "memory_version": commit_version}, error=None))
        return get_operation(user_id, project_id, operation_id=op["id"])

    try:
        async with UserLease(str(user_id), project_id) as lease:
            try:
                state = await run_sql(snapshot, lease)
                if isinstance(state, Operation):
                    return state
                affected_blobs, changed_facts, message_rows = state
                withdrawn = {m["message_id"] for m in message_rows if m["deleted"]} | set(request.message_ids)
                surviving, removed, reindex = [], [], []
                for fact in changed_facts:
                    groups = retained_groups(fact["support_groups"], withdrawn)
                    if not groups:
                        removed.append(fact["id"])
                        continue
                    value = {**fact, "support_groups": groups,
                        "occurred_at": evidence_time(groups, message_rows),
                        "fact_time": supported_fact_time(fact.get("fact_time"), groups)}
                    value["search_text"] = render_search_fact(value["content"], value["fact_time"])
                    previous_text = fact["search_text"] or render_search_fact(fact["content"], fact.get("fact_time"))
                    if value["search_text"] != previous_text:
                        reindex.append(value)
                    surviving.append(value)
                vectors = await _fact_vectors(project_id, reindex)
                for fact, vector in zip(reindex, vectors, strict=True):
                    fact["embedding"] = vector
                return await run_sql(commit, lease, affected_blobs, changed_facts, withdrawn, surviving, removed)
            except (SourceError, LeaseLost) as error:
                if isinstance(error, LeaseLost):
                    error = SourceError("lease_lost", "Processing ownership was lost", 409, True)
                await run_sql(_set_failure, user_id, project_id, op, lease, error)
                raise error
    except LeaseUnavailable:
        return await run_sql(get_operation, user_id, project_id, operation_id=op["id"])


def _register_correction(user_id, project_id, fact_id, action, request):
    payload = {"fact_id": str(fact_id), "action": action, **request.model_dump(mode="json")}
    # Preserve receipt identity across the wire-field rename. Completed receipts
    # have erased their edit payload, so their historical hash cannot be rebuilt.
    fingerprint = dict(payload)
    if "fact_time" in fingerprint:
        fingerprint["event_time"] = fingerprint.pop("fact_time")
    digest = _hash({"kind": "correct", "request": fingerprint})
    with Session.begin() as session:
        assert_user_active(session, user_id, project_id)
        previous = session.execute(select(operations).where(_scope(operations, user_id, project_id),
            operations.c.idempotency_key == request.idempotency_key).with_for_update()).mappings().one_or_none()
        # Receipts survive their target: replay a committed delete before looking
        # for that now-absent Fact or evaluating its original expected revision.
        if previous is not None:
            if previous["request_hash"] != digest:
                raise SourceError("idempotency_conflict", "Idempotency key was used for a different request", 409)
            now = datetime.now(timezone.utc)
            expired = not previous["input_expires_at"] or previous["input_expires_at"] <= now
            if expired:
                expired_row = session.execute(_expire_correction_inputs(now).where(
                    operations.c.id == previous["id"]).returning(operations)).mappings().one_or_none()
                if expired_row is not None:
                    previous = expired_row
            restored = expired and _can_process(previous, explicit_retry=True)
            if restored:
                session.execute(update(operations).where(operations.c.id == previous["id"]).values(
                    request={**payload, "source_id": previous["source_id"]},
                    input_expires_at=now + timedelta(seconds=CONFIG.source_input_retention_seconds)))
            return dict(previous), restored
        original = session.execute(select(facts.c.id, blobs.c.source_id, blobs.c.message_ids).join(blobs,
            and_(blobs.c.id == facts.c.blob_id, blobs.c.user_id == facts.c.user_id,
                 blobs.c.project_id == facts.c.project_id)).where(_scope(facts, user_id, project_id),
            facts.c.id == fact_id)).mappings().one_or_none()
        if original is None:
            raise SourceError("fact_not_found", "Fact not found", 404)
        blob_id, operation_id = uuid4(), uuid4()
        session.execute(insert(blobs).values(id=blob_id, user_id=user_id, project_id=project_id,
            source_id=original["source_id"], kind="correct", status="active", message_ids=original["message_ids"]))
        session.execute(insert(operations).values(id=operation_id, user_id=user_id, project_id=project_id,
            idempotency_key=request.idempotency_key, kind="correct", request_hash=digest,
            request={**payload, "source_id": original["source_id"]}, source_id=original["source_id"],
            blob_id=blob_id, status="processing", input_expires_at=datetime.now(timezone.utc)
                + timedelta(seconds=CONFIG.source_input_retention_seconds)))
        return dict(session.execute(select(operations).where(operations.c.id == operation_id)).mappings().one()), False


def _correction_values(request, fact, original, message_rows):
    values = request.model_dump(mode="json", exclude={"idempotency_key", "expected_revision", "reason"})
    known = {row["message_id"]: row for row in message_rows if not row["deleted"]}
    membership = set(original["message_ids"])
    for group in values["support_groups"]:
        if not set(group).issubset(membership) or not set(group).issubset(known):
            raise SourceError("invalid_fact_evidence", "Evidence must use undeleted messages from the original Blob", 422)
        if not any(known[mid]["role"] == "user" for mid in group):
            raise SourceError("invalid_fact_evidence", "Every support group requires user evidence", 422)
    if values["fact_time"] is not None and supported_fact_time(values["fact_time"], values["support_groups"]) is None:
        raise SourceError("invalid_fact_evidence", "Time evidence must be jointly supported by a fact evidence group", 422)
    # Raw messages are already erased. These checks prove identity/structure,
    # never that the caller's revised statement or quoted time is semantically true.
    values["occurred_at"] = evidence_time(values["support_groups"], message_rows)
    values["search_text"] = render_search_fact(values["content"], values["fact_time"])
    values["embedding"] = fact["embedding"]
    return values


async def update_fact(user_id, project_id, fact_id, request: UpdateFact, *, explicit_retry=False):
    return await _correct_fact(user_id, project_id, fact_id, "update", request, explicit_retry=explicit_retry)


async def delete_fact(user_id, project_id, fact_id, request: DeleteFact, *, explicit_retry=False):
    return await _correct_fact(user_id, project_id, fact_id, "delete", request, explicit_retry=explicit_retry)


async def _correct_fact(user_id, project_id, fact_id, action, request, *, explicit_retry):
    fact_id = UUID(str(fact_id))
    op, restored = await run_sql(_register_correction, user_id, project_id, fact_id, action, request)
    if restored:
        return _operation(op)
    if op["status"] == "failed" and not explicit_retry:
        return _operation(op)
    if not _can_process(op, explicit_retry=explicit_retry):
        return _operation(op)

    def snapshot(lease):
        with Session.begin() as session:
            assert_user_active(session, user_id, project_id)
            current = session.execute(select(operations).where(operations.c.id == op["id"],
                _scope(operations, user_id, project_id)).with_for_update()).mappings().one()
            if current["status"] == "failed" and not explicit_retry:
                return _operation(current)
            if not _can_process(current, explicit_retry=explicit_retry):
                return _operation(current)
            _fence_snapshot(session, user_id, project_id, lease)
            fact = session.execute(select(facts).where(_scope(facts, user_id, project_id),
                facts.c.id == fact_id)).mappings().one_or_none()
            original = session.execute(select(blobs).where(_scope(blobs, user_id, project_id),
                blobs.c.id == fact["blob_id"])).mappings().one() if fact else None
            rows = _message_rows(session, user_id, project_id, op["source_id"], original["message_ids"]) if original else []
            session.execute(update(operations).where(operations.c.id == op["id"]).values(
                status="processing", error=None, generation=lease.generation))
            return (dict(fact) if fact else None, dict(original) if original else None, rows,
                    current["input_expires_at"])

    def commit(lease, before, values, changed):
        with Session.begin() as session:
            assert_user_active(session, user_id, project_id)
            lease.assert_owned()
            current = session.execute(select(operations).where(_scope(operations, user_id, project_id),
                operations.c.id == op["id"], operations.c.generation == lease.generation,
                operations.c.status == "processing").with_for_update()).mappings().one_or_none()
            if current is None:
                raise SourceError("write_conflict", "Correction ownership changed", 409, True)
            if not current["input_expires_at"] or current["input_expires_at"] <= datetime.now(timezone.utc):
                raise SourceError("input_required", "Temporary correction input expired", 409)
            revision = session.scalar(select(facts.c.revision).where(_scope(facts, user_id, project_id),
                facts.c.id == fact_id).with_for_update())
            if revision != request.expected_revision:
                raise SourceError("fact_revision_conflict", "Fact changed; read its current revision before correcting", 409)
            if changed:
                fence_commit(session, user_id, project_id, lease)
                version = session.info["memoia_committed_version"][1]
            else:
                state = session.execute(select(states.c.generation, states.c.version).where(
                    _identity(user_id, project_id))).one()
                if tuple(state) != (lease.generation, lease.version):
                    raise SourceError("write_conflict", "Memory changed while the result was computed", 409, True)
                session.info["memoia_fence_done"] = True
                version = lease.version
            if action == "delete":
                session.execute(delete(facts).where(_scope(facts, user_id, project_id), facts.c.id == fact_id))
            elif changed:
                session.execute(update(facts).where(_scope(facts, user_id, project_id), facts.c.id == fact_id)
                    .values(**values, revision=revision + 1, updated_at=func.now()))
            changes = [{"fact_id": str(fact_id), "kind": "deleted" if action == "delete" else "updated"}] if changed else []
            _scrub_history(session, user_id, project_id, {str(fact_id)} if changed else set())
            from .maintenance import record_changes
            record_changes(session, user_id, project_id, op["blob_id"], version, changes)
            audit = {"source_id": op["source_id"], "idempotency_key": request.idempotency_key,
                     "fact_id": str(fact_id), "action": action, "reason": request.reason,
                     "before_revision": before["revision"],
                     "after_revision": None if action == "delete" else revision + int(changed)}
            session.execute(update(operations).where(operations.c.id == op["id"]).values(status="completed",
                result={"event_ids": [], "profile_ids": [], "fact_ids": [str(fact_id)], "memory_version": version},
                error=None, request=audit, input_expires_at=None))
        return get_operation(user_id, project_id, operation_id=op["id"])

    try:
        async with UserLease(str(user_id), project_id) as lease:
            try:
                state = await run_sql(snapshot, lease)
                if isinstance(state, Operation):
                    return state
                before, original, rows, expiry = state
                if not expiry or expiry <= datetime.now(timezone.utc):
                    raise SourceError("input_required", "Temporary correction input expired", 409)
                if before is None:
                    raise SourceError("fact_not_found", "Fact not found", 404)
                if before["revision"] != request.expected_revision:
                    raise SourceError("fact_revision_conflict", "Fact changed; read its current revision before correcting", 409)
                values, changed = None, True
                if action == "update":
                    values = _correction_values(request, before, original, rows)
                    fields = ("content", "subject", "reporter", "certainty", "support_groups", "fact_time", "occurred_at")
                    changed = any(values[field] != before[field] for field in fields)
                    previous_text = before["search_text"] or render_search_fact(before["content"], before["fact_time"])
                    if changed and values["search_text"] != previous_text:
                        values["embedding"] = (await _fact_vectors(project_id, [values]))[0]
                return await run_sql(commit, lease, before, values, changed)
            except (SourceError, LeaseLost) as error:
                if isinstance(error, LeaseLost):
                    error = SourceError("lease_lost", "Processing ownership was lost", 409, True)
                await run_sql(_set_failure, user_id, project_id, op, lease, error)
                raise error
    except LeaseUnavailable:
        return await run_sql(get_operation, user_id, project_id, operation_id=op["id"])
