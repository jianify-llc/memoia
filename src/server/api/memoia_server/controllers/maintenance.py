"""Fixed Blob batches; Operations own flush scheduling, receipts and execution."""

import asyncio
import json
import time
from contextlib import suppress
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from uuid import UUID, uuid4

from sqlalchemy import JSON, and_, column, delete, func, or_, select, true, union, update, exists
from sqlalchemy.dialects.postgresql import JSONB, insert

from ..connectors import Session, run_sql
from ..models.source import memory_operations as operations, memory_blobs as blobs
from ..models.database import User
from ..utils import json_size as payload_size
from .source import SourceError, _scope, _hash, assert_user_active, lock_user_identity
from .derived_impact import IMPACT_KEY, affected, public_data

QUIET_SECONDS = 30
MAX_WAIT_SECONDS = 120
TASK_LEASE_SECONDS = 60
RETRY_SECONDS = (300, 900, 3600)
MAX_ATTEMPTS = 4
MAX_FLUSH_BYTES = 256 * 1024
MAX_FLUSH_SCAN = 100


def record_changes(session, user_id, project_id, blob_id, version, changes):
    """Fact effects and this fixed batch's change references share one transaction."""
    updated = session.execute(update(blobs).where(
        _scope(blobs, user_id, project_id), blobs.c.id == blob_id,
        blobs.c.fact_completed_at.is_(None), blobs.c.flush_operation_id.is_(None),
    ).values(fact_completed_at=func.now(), fact_changes=[
        {**change, "version": version} for change in (changes or [{"kind": "noop"}])
    ])).rowcount
    if updated != 1:
        raise SourceError("blob_conflict", "Fixed Fact batch was already completed", 409, True)
    changed_ids = {_uuid(change["fact_id"]) for change in (changes or [])
                   if change.get("fact_id") and change["kind"] != "added"}
    if changed_ids:
        from ..models.database import UserProfile, UserEvent
        # Invalidate readers of derived text as well as direct Fact readers. The
        # text may remain visible until flush, but old computations cannot commit.
        for collection, table in (("profiles", UserProfile.__table__), ("events", UserEvent.__table__)):
            session.execute(update(table).where(_scope(table, user_id, project_id),
                _associated_entries(table, collection, user_id, project_id, changed_ids,
                                    include_unknown=True))
                .values(revision=table.c.revision + 1, updated_at=table.c.updated_at))


def _unassigned(user_id, project_id):
    return and_(_scope(blobs, user_id, project_id), blobs.c.fact_completed_at.is_not(None),
                blobs.c.flush_operation_id.is_(None))


def pending_derived_fact_ids(user_id, project_id, fact_ids):
    """Scoped SQL IDs whose old derived links await a successful flush.

    Callers supply only their candidate IDs (strings, or a scoped SQL select).
    Navigation links and direct Fact reads remain independent of this public proof filter.
    """
    blob_change = func.jsonb_array_elements(blobs.c.fact_changes).table_valued(
        column("value", JSONB)).alias("blob_change")
    legacy_change = func.jsonb_array_elements(operations.c.request["legacy_changes"]).table_valued(
        column("value", JSONB)).alias("legacy_change")
    unfinished = select(operations.c.id).where(
        _scope(operations, user_id, project_id), operations.c.kind == "flush",
        operations.c.status != "completed")
    blob_ids = select(blob_change.c.value["fact_id"].astext).select_from(blobs.join(blob_change, true())).where(
        _scope(blobs, user_id, project_id), blobs.c.fact_completed_at.is_not(None),
        or_(blobs.c.flush_operation_id.is_(None), blobs.c.flush_operation_id.in_(unfinished)),
        blob_change.c.value["kind"].astext.in_(["updated", "evidence", "deleted"]),
        blob_change.c.value["fact_id"].astext.in_(fact_ids))
    legacy_ids = select(legacy_change.c.value["fact_id"].astext).select_from(
        operations.join(legacy_change, true())).where(
        _scope(operations, user_id, project_id), operations.c.kind == "flush",
        operations.c.status != "completed",
        legacy_change.c.value["kind"].astext.in_(["updated", "evidence", "deleted"]),
        legacy_change.c.value["fact_id"].astext.in_(fact_ids))
    return union(blob_ids, legacy_ids)


def _change_facts(session, user_id, project_id, changes):
    from ..models.source import memory_facts
    fact_ids = {_uuid(change["fact_id"]) for change in changes if change.get("fact_id")}
    if not fact_ids:
        return {}
    return {row.id: dict(row) for row in session.execute(select(
        memory_facts.c.id, memory_facts.c.content, memory_facts.c.subject,
        memory_facts.c.reporter, memory_facts.c.certainty, memory_facts.c.support_groups,
        memory_facts.c.occurred_at, memory_facts.c.fact_time,
        memory_facts.c.created_at, memory_facts.c.updated_at,
    ).where(_scope(memory_facts, user_id, project_id), memory_facts.c.id.in_(fact_ids))).mappings()}


def _change_size(changes, facts):
    ids = {_uuid(change["fact_id"]) for change in changes if change.get("fact_id")}
    return payload_size({"changes": changes, "facts": [facts[ident] for ident in ids if ident in facts]})


def _seal(session, user_id, project_id, key):
    # The caller holds the short user identity lock: completion, sealing and
    # forgetting are linearized, without carrying that lock into model work.
    request_hash = _hash({"kind": "flush", "idempotency_key": key})
    previous = session.execute(select(operations).where(
        _scope(operations, user_id, project_id), operations.c.idempotency_key == key)).mappings().one_or_none()
    if previous is not None:
        if previous["kind"] != "flush" or previous["request_hash"] != request_hash:
            raise SourceError("idempotency_conflict", "Idempotency key identifies another operation", 409)
        return previous
    candidates = session.execute(select(blobs.c.id, blobs.c.fact_changes).where(_unassigned(user_id, project_id))
        .order_by(blobs.c.fact_completed_at, blobs.c.id).limit(MAX_FLUSH_SCAN).with_for_update()).all()
    facts = _change_facts(session, user_id, project_id, [change for _, changes in candidates for change in changes])
    batch_ids, used, oversized = [], 0, False
    for bid, changes in candidates:
        cost = _change_size(changes, facts)
        if batch_ids and used + cost > MAX_FLUSH_BYTES:
            break
        batch_ids.append(bid)
        used += cost
        if cost > MAX_FLUSH_BYTES:
            # Preserve this indivisible Blob's fixed identity, expose capacity failure,
            # and let subsequent Blobs proceed instead of sealing an unbounded batch.
            oversized = True
            break
    ident = uuid4()
    result = None if batch_ids else {"blob_ids": [], "profile_ids": [], "event_ids": []}
    session.execute(insert(operations).values(
        id=ident, user_id=user_id, project_id=project_id, idempotency_key=key,
        kind="flush", request_hash=request_hash,
        request={"blob_ids": list(map(str, batch_ids))},
        source_id=None, blob_id=None,
        status="failed" if oversized else "processing" if batch_ids else "completed",
        error={"code": "maintenance_capacity", "retryable": False} if oversized else None,
        result=result, generation=0, available_at=func.now(),
    ))
    if batch_ids:
        session.execute(update(blobs).where(_unassigned(user_id, project_id), blobs.c.id.in_(batch_ids))
                        .values(flush_operation_id=ident))
    return session.execute(select(operations).where(operations.c.id == ident)).mappings().one()


def flush(user_id, project_id, key):
    from .source import _operation
    with Session.begin() as session:
        session.info["memoia_non_memory_commit"] = True
        assert_user_active(session, user_id, project_id)
        if session.scalar(select(User.id).where(User.id == user_id, User.project_id == project_id)) is None:
            raise SourceError("user_not_found", "User not found", 404)
        return _operation(_seal(session, user_id, project_id, key))


def seal_due():
    """The Blob completion times are the only quiet-window clock; reads do not touch it."""
    with Session.begin() as session:
        session.info["memoia_non_memory_commit"] = True
        # Lock existing user rows briefly, not all batches or long model requests.
        due = select(blobs.c.user_id, blobs.c.project_id).where(
            blobs.c.fact_completed_at.is_not(None), blobs.c.flush_operation_id.is_(None)
        ).group_by(blobs.c.user_id, blobs.c.project_id).having(or_(
            func.max(blobs.c.fact_completed_at) <= func.now() - timedelta(seconds=QUIET_SECONDS),
            func.min(blobs.c.fact_completed_at) <= func.now() - timedelta(seconds=MAX_WAIT_SECONDS),
        )).subquery()
        owners = session.execute(select(User.id, User.project_id).join(due,
            and_(User.id == due.c.user_id, User.project_id == due.c.project_id))
            .order_by(User.project_id, User.id).limit(100).with_for_update(skip_locked=True, of=User)).all()
        for uid, pid in owners:
            # Never wait for an identity lock while holding its User row: forgetting
            # acquires them in the opposite order. Busy users are picked next poll.
            if not lock_user_identity(session, uid, pid, wait=False):
                continue
            assert_user_active(session, uid, pid)
            # Recheck under the identity lock; a concurrent explicit flush may have
            # sealed the original set already.
            first, latest = session.execute(select(func.min(blobs.c.fact_completed_at),
                func.max(blobs.c.fact_completed_at)).where(_unassigned(uid, pid))).one()
            now = session.scalar(select(func.now()))
            if first and min(latest + timedelta(seconds=QUIET_SECONDS),
                             first + timedelta(seconds=MAX_WAIT_SECONDS)) <= now:
                _seal(session, uid, pid, f"auto-flush:{uuid4()}")


def progress(row, *, now=None):
    now = now or datetime.now(timezone.utc)
    running = row["lease_until"] is not None and row["lease_until"] > now
    error = row["error"]
    state = (row["status"] if row["status"] in {"completed", "failed"}
             else "running" if running else "pending")
    return {"operation_id": row["id"], "status": state, "blob_ids": row["request"]["blob_ids"],
            "attempts": row["attempts"], "available_at": row["available_at"],
            "error": error, "retryable": bool(error and error["retryable"])}


@dataclass(frozen=True)
class Claim:
    operation_id: UUID
    user_id: str
    project_id: str
    owner: UUID
    generation: int
    attempts: int
    blob_ids: list[str]
    changes: list[dict]

    @property
    def through_version(self):
        return max((change.get("version", 0) for change in self.changes), default=0)


def _owned(claim):
    return and_(operations.c.id == claim.operation_id, _scope(operations, claim.user_id, claim.project_id),
                operations.c.kind == "flush", operations.c.status != "completed",
                operations.c.lease_owner == claim.owner, operations.c.generation == claim.generation,
                operations.c.lease_until > func.clock_timestamp())


def _release_failure(session, row, code, retryable):
    automatic_retry = retryable and 0 < row["attempts"] < MAX_ATTEMPTS
    values = dict(status="processing" if automatic_retry else "failed", lease_owner=None, lease_until=None,
                  error={"code": code, "retryable": retryable})
    if automatic_retry:
        values["available_at"] = func.now() + timedelta(seconds=RETRY_SECONDS[row["attempts"] - 1])
    session.execute(update(operations).where(operations.c.id == row["id"]).values(**values))


def reap_expired():
    """End abandoned attempts independently of eligibility for another attempt."""
    with Session.begin() as session:
        session.info["memoia_non_memory_commit"] = True
        rows = session.execute(select(operations).where(
            operations.c.kind == "flush", operations.c.status != "completed",
            operations.c.lease_owner.is_not(None), operations.c.lease_until <= func.clock_timestamp(),
        ).order_by(operations.c.lease_until, operations.c.id).limit(100)
          .with_for_update(skip_locked=True)).mappings().all()
        for row in rows:
            _release_failure(session, row, "maintenance_lease_expired", True)
    return len(rows)


def claim_next(*, lease_seconds=TASK_LEASE_SECONDS):
    """One effective Loop per user; backoff belongs to an operation, not the user."""
    with Session.begin() as session:
        session.info["memoia_non_memory_commit"] = True
        eligible = and_(operations.c.kind == "flush", operations.c.status != "completed",
            operations.c.attempts < MAX_ATTEMPTS, operations.c.available_at <= func.now(),
            or_(operations.c.error.is_(None), operations.c.error["retryable"].as_boolean().is_(True)))
        # User row lock serializes competing operations without head-of-line blocking
        # different users. The partial unique index also rejects two lease owners.
        owners = session.execute(select(User.id, User.project_id).where(exists(
            select(operations.c.id).where(eligible, operations.c.user_id == User.id,
                                         operations.c.project_id == User.project_id)))
            .order_by(User.project_id, User.id).limit(100)
            .with_for_update(skip_locked=True, of=User)).all()
        for uid, pid in owners:
            if not lock_user_identity(session, uid, pid, wait=False):
                continue
            assert_user_active(session, uid, pid)
            held = session.execute(select(operations).where(_scope(operations, uid, pid),
                operations.c.kind == "flush", operations.c.lease_owner.is_not(None))
                .with_for_update()).mappings().one_or_none()
            now = session.scalar(select(func.now()))
            if held is not None:
                if held["lease_until"] > now:
                    continue
                _release_failure(session, held, "maintenance_lease_expired", True)
            row = session.execute(select(operations).where(eligible, _scope(operations, uid, pid),
                operations.c.lease_owner.is_(None)).order_by(operations.c.available_at, operations.c.created_at, operations.c.id)
                .limit(1).with_for_update()).mappings().one_or_none()
            if row is None:
                continue
            owner = uuid4()
            generation = (row["generation"] or 0) + 1
            session.execute(update(operations).where(operations.c.id == row["id"]).values(
                status="processing", lease_owner=owner, lease_until=now + timedelta(seconds=lease_seconds),
                generation=generation, attempts=row["attempts"] + 1, error=None))
            changes = [change for batch in session.scalars(select(blobs.c.fact_changes).where(
                _scope(blobs, uid, pid), blobs.c.flush_operation_id == row["id"])) for change in batch]
            # Only migration-era unmatched references live in request; new runs use
            # Blob as the single Fact-change owner.
            changes.extend(row["request"].get("legacy_changes", []))
            return Claim(row["id"], str(uid), pid, owner, generation,
                         row["attempts"] + 1, row["request"]["blob_ids"], changes)
    return None


def renew_claim(claim, *, lease_seconds=TASK_LEASE_SECONDS):
    with Session.begin() as session:
        session.info["memoia_non_memory_commit"] = True
        return session.execute(update(operations).where(_owned(claim)).values(
            lease_until=func.clock_timestamp() + timedelta(seconds=lease_seconds))).rowcount == 1


def assert_claim(session, claim):
    row = session.execute(select(operations).where(_owned(claim)).with_for_update()).mappings().one_or_none()
    if row is None:
        raise SourceError("maintenance_lease_lost", "Flush execution ownership was lost", 409, True)
    return row


def complete_flush(session, claim, plan):
    assert_claim(session, claim)
    if session.execute(update(operations).where(_owned(claim)).values(
        status="completed", lease_owner=None, lease_until=None, error=None,
        result={"blob_ids": claim.blob_ids, "memory_version": claim.through_version,
                "profile_ids": [change.id for change in plan.profiles if change.action == "upsert"],
                "event_ids": [change.id for change in plan.events if change.action == "upsert"]},
    )).rowcount != 1:
        raise SourceError("maintenance_lease_lost", "Flush execution expired before acknowledgement", 409, True)


def fail_claim(claim, error):
    from ..env import LOG
    from openai import APIConnectionError, APIStatusError
    from redis.exceptions import ConnectionError as RedisConnectionError, TimeoutError as RedisTimeoutError
    from sqlalchemy.exc import OperationalError, TimeoutError as DatabaseTimeoutError
    if hasattr(error, "retryable"):
        code, retryable = getattr(error, "code", "maintenance_failed"), bool(error.retryable)
    elif isinstance(error, APIStatusError):
        retryable = error.status_code in {408, 429} or error.status_code >= 500
        code = "model_unavailable" if retryable else "model_configuration_rejected"
    elif isinstance(error, (APIConnectionError, TimeoutError)):
        code, retryable = "model_unavailable", True
    elif isinstance(error, (RedisConnectionError, RedisTimeoutError)):
        code, retryable = "coordination_unavailable", True
    elif isinstance(error, (OperationalError, DatabaseTimeoutError)):
        code, retryable = "database_unavailable", True
    else:
        code, retryable = "maintenance_failed", False
    with Session.begin() as session:
        session.info["memoia_non_memory_commit"] = True
        row = session.execute(select(operations).where(_owned(claim)).with_for_update()).mappings().one_or_none()
        if row is None:
            return False
        _release_failure(session, row, code, retryable)
    LOG.warning("Flush rejected: operation=%s code=%s retryable=%s attempt=%s",
                claim.operation_id, code, retryable, claim.attempts)
    return True


def retry_flush(user_id, project_id, operation_id):
    from .source import _operation
    with Session.begin() as session:
        session.info["memoia_non_memory_commit"] = True
        assert_user_active(session, user_id, project_id)
        row = session.execute(select(operations).where(_scope(operations, user_id, project_id),
            operations.c.id == operation_id, operations.c.kind == "flush").with_for_update()).mappings().one_or_none()
        if row is None:
            raise SourceError("operation_not_found", "Original flush not found", 404)
        if row["status"] == "completed":
            return _operation(row)
        now = session.scalar(select(func.now()))
        if row["lease_until"] and row["lease_until"] > now:
            return _operation(row)
        # Pending work is not a recovery request: repeated clicks cannot reset its
        # budget. Only an explicit failed/expired original operation is reopened.
        if row["status"] == "failed" or row["lease_owner"] is not None:
            session.execute(update(operations).where(operations.c.id == row["id"]).values(
                status="processing", attempts=0, error=None, available_at=now,
                lease_owner=None, lease_until=None))
        row = session.execute(select(operations).where(operations.c.id == row["id"])).mappings().one()
        return _operation(row)


def get_status(user_id, project_id):
    with Session() as session:
        assert_user_active(session, user_id, project_id)
        count = session.scalar(select(func.count()).select_from(blobs).where(_unassigned(user_id, project_id)))
        rows = session.execute(select(operations).where(_scope(operations, user_id, project_id),
            operations.c.kind == "flush").order_by(
            (operations.c.status == "completed"), operations.c.created_at.desc(), operations.c.id)
            .limit(50)).mappings().all()
        return {"pending_blob_count": count, "flushes": [progress(row) for row in rows]}


class TaskLease:
    """One flush heartbeat spans the unified Loop; generation fences every renewal."""

    def __init__(self, claim: Claim, *, ttl: float = TASK_LEASE_SECONDS):
        self.claim, self.ttl = claim, ttl
        self.lost = asyncio.Event()
        self._valid_until = time.monotonic() + ttl
        self._heartbeat = None

    async def __aenter__(self):
        if not await run_sql(renew_claim, self.claim, lease_seconds=self.ttl):
            self.lost.set()
            raise SourceError("maintenance_lease_lost", "Maintenance claim expired before execution", 409, True)
        self._valid_until = time.monotonic() + self.ttl
        self._heartbeat = asyncio.create_task(self._renew())
        return self

    def check_active(self):
        if time.monotonic() >= self._valid_until:
            self.lost.set()
        if self.lost.is_set():
            raise SourceError("maintenance_lease_lost", "Maintenance execution ownership was lost", 409, True)

    async def assert_active(self):
        self.check_active()

    async def _renew(self):
        try:
            while True:
                await asyncio.sleep(self.ttl / 3)
                async with asyncio.timeout(self.ttl / 3):
                    owned = await run_sql(renew_claim, self.claim, lease_seconds=self.ttl)
                if not owned:
                    self.lost.set()
                    return
                self._valid_until = time.monotonic() + self.ttl
        except Exception:
            self.lost.set()

    async def __aexit__(self, *_):
        self._heartbeat.cancel()
        with suppress(asyncio.CancelledError):
            await self._heartbeat
        self.lost.set()


def _scope(table, user_id, project_id):
    return and_(table.c.user_id == user_id, table.c.project_id == project_id)


def _uuid(value):
    try:
        return UUID(str(value))
    except (ValueError, TypeError, AttributeError):
        raise SourceError("maintenance_invalid_identifier", "Memory identifier is invalid", 502) from None


class DBMaintenanceContext:
    """Tools read this user only, and stage one finite Loop-local change set."""

    def __init__(self, claim: Claim, lease: TaskLease):
        from .source import _project_rules
        self.claim, self.lease = claim, lease
        self.operation_id = claim.operation_id
        self.user_id, self.project_id = claim.user_id, claim.project_id
        self.changes = claim.changes
        with Session.begin() as session:
            # Recovery reads current Facts, so a formerly small batch may have
            # grown. Keep the sealed identity, but reject unbounded model work.
            if _change_size(self.changes, _change_facts(session, self.user_id, self.project_id, self.changes)) > MAX_FLUSH_BYTES:
                raise SourceError("maintenance_capacity", "Fixed Blob changes exceed the flush budget", 413)
            rules = _project_rules(session, self.project_id)
            assert_claim(session, claim)
        self.profile_topics = rules["profile_topics"]
        self.allowed_topics = [topic["topic"] for topic in self.profile_topics]
        self.event_tag_definitions = rules["event_tag_definitions"] or []
        self.language = rules["language"]
        self.llm_model = rules["llm_model"]
        self.reasoning_effort = rules["reasoning_effort"]
        self.readset = {"facts": {}, "profiles": {}, "events": {}}
        self._derived_reads = {"profiles": set(), "events": set()}
        self._review_required = {"profiles": set(), "events": set()}
        self._staged = {"profiles": {}, "events": {}}
        self._unresolved_staging = {}
        self._seen_changes = set()
        self._prepare_affected()
        self._review_progress_bytes = payload_size(self._remaining_review(include_resolved=True)) + 32

    def _prepare_affected(self):
        from ..models.database import UserProfile, UserEvent
        from ..maintenance_agent import ProfileMutation, EventMutation
        changed_ids = {_uuid(change["fact_id"]) for change in self.changes
                       if change.get("fact_id") and change.get("kind") != "added"}
        if not changed_ids:
            return
        with Session() as session:
            assert_user_active(session, self.user_id, self.project_id)
            for collection, table, mutation in (
                ("profiles", UserProfile.__table__, ProfileMutation),
                ("events", UserEvent.__table__, EventMutation),
            ):
                rows = session.execute(select(table.c.id, table.c.revision)
                    .where(_scope(table, self.user_id, self.project_id),
                           _associated_entries(table, collection, self.user_id, self.project_id,
                                               changed_ids, include_unknown=True))).mappings().all()
                support = _entry_support(session, table, collection, self.claim, [row["id"] for row in rows])
                if any(str(row["id"]) not in support for row in rows):
                    raise SourceError("maintenance_read_conflict", "Memory disappeared while preparing review", 409, True)
                known = set().union(*support.values()) if support else set()
                from ..models.source import memory_facts
                current = set(map(str, session.scalars(select(memory_facts.c.id).where(
                    _scope(memory_facts, self.user_id, self.project_id),
                    memory_facts.c.id.in_([_uuid(fid) for fid in known]))))) if known else set()
                for row in rows:
                    ident = str(row["id"])
                    self.readset[collection][ident] = row["revision"]
                    self._review_required[collection].add(ident)
                    # Possible influence requires a decision, not deletion. Only
                    # known support that has entirely disappeared is auto-removed.
                    if support[ident] and not support[ident].intersection(current):
                        for fid in support[ident]:
                            self.readset["facts"][fid] = None
                        self._staged[collection][ident] = mutation(action="remove", id=ident)

    def _remaining_review(self, *, include_resolved=False):
        # Reuse the prepared scope; optional reads do not create new obligations.
        # Accepted decisions advance this bounded preview without a second cursor.
        result = {}
        for collection, required in self._review_required.items():
            pending = set(required) if include_resolved else required - self._staged[collection].keys()
            pending |= {ident for kind, ident in self._unresolved_staging
                        if kind + "s" == collection and ident in required}
            result[collection] = {"count": len(pending), "ids": sorted(pending)[:20]}
        return result

    async def assert_active(self):
        await self.lease.assert_active()

    def _read(self, collection, ids, cursor, query, limit, readset, staged):
        from ..models.database import UserProfile, UserEvent
        from ..models.source import memory_facts, memory_blobs, memory_event_facts
        from ..maintenance_agent import MAX_PAGE_SIZE, MAX_TOOL_BYTES

        tables = {"facts": memory_facts, "profiles": UserProfile.__table__, "events": UserEvent.__table__}
        if collection not in tables:
            raise SourceError("invalid_model_output", "Unsupported memory collection", 502)
        if not 1 <= limit <= MAX_PAGE_SIZE or (ids is not None and len(ids) > MAX_PAGE_SIZE):
            raise SourceError("invalid_model_output", "Memory page limit exceeded", 502)
        try:
            after = UUID(cursor) if cursor is not None else None
        except (ValueError, TypeError, AttributeError):
            raise SourceError("invalid_model_output", "Memory page cursor is invalid", 502) from None
        if query and len(query) > 500:
            raise SourceError("invalid_model_output", "Memory query exceeds limit", 502)
        requested = {_uuid(value) for value in ids} if ids is not None else None
        staged_page = {ident: change for ident, change in staged.items()
                       if (after is None or _uuid(ident) > after)
                       and (requested is None or _uuid(ident) in requested)}
        table = tables[collection]
        statement = select(table).where(_scope(table, self.user_id, self.project_id))
        # Staged entries replace their DB rows before filtering and paging. A
        # stable ID boundary cannot shift when an earlier entry is updated/removed.
        if staged:
            statement = statement.where(table.c.id.not_in([_uuid(ident) for ident in staged]))
        if after is not None:
            statement = statement.where(table.c.id > after)
        changed_ids = [_uuid(change["fact_id"]) for change in self.changes if change.get("fact_id")]
        if ids is None and not query:
            if collection == "facts":
                statement = statement.where(table.c.id.in_(changed_ids))
            else:
                statement = statement.where(_associated_entries(
                    table, collection, self.user_id, self.project_id, changed_ids,
                    include_unknown=any(change.get("fact_id") and change["kind"] != "added"
                                        for change in self.changes)))
        if requested is not None:
            statement = statement.where(table.c.id.in_(requested))
        if query:
            pattern = "%" + query.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
            columns = [table.c.content] if collection != "events" else [
                table.c.event_data[key].astext for key in ("event_tip", "content", "title", "summary", "keywords")]
            if collection == "profiles":
                columns.extend(table.c.attributes[key].astext for key in ("topic", "sub_topic"))
            statement = statement.where(or_(*(column.ilike(pattern, escape="\\") for column in columns)))
        with Session() as session:
            assert_user_active(session, self.user_id, self.project_id)
            rows = [dict(row) for row in session.execute(statement.order_by(table.c.id)
                    .limit(limit + 1)).mappings()]
            staged_rows = {str(row["id"]): dict(row) for row in session.execute(select(table).where(
                _scope(table, self.user_id, self.project_id),
                table.c.id.in_([_uuid(ident) for ident in staged_page]))).mappings()} if staged_page else {}
            if requested is not None:
                present = set(map(str, session.scalars(select(table.c.id).where(
                    _scope(table, self.user_id, self.project_id), table.c.id.in_(requested)))))
                for value in requested:
                    ident = str(value)
                    if ident not in present:
                        if readset[collection].get(ident) is not None:
                            raise SourceError("maintenance_read_conflict", "Memory disappeared during the Loop", 409, True)
                        readset[collection][ident] = None

            def entry(row):
                ident = str(row["id"])
                if collection == "facts":
                    item = dict(row)
                    for key in ("embedding", "search_text", "included"):
                        item.pop(key, None)
                elif collection == "profiles":
                    attributes = row["attributes"] or {}
                    item = {"id": ident, "content": row["content"], "revision": row["revision"],
                            "topic": attributes.get("topic", ""), "sub_topic": attributes.get("sub_topic", ""),
                            "fact_ids": attributes.get("fact_ids") or []}
                else:
                    # Legacy JSON retains identity only. Its old evidence text is
                    # never reintroduced as valid Fact support after withdrawal.
                    data = row["event_data"] or {}
                    legacy_ids = [value["fact_id"] for value in (data.get("evidence") or [])
                                  if isinstance(value, dict) and value.get("fact_id")]
                    item = {**public_data(data), "id": ident, "revision": row["revision"],
                            "fact_ids": sorted({*(data.get("fact_ids") or []), *legacy_ids})}
                    item.pop("evidence", None)
                item.pop("user_id", None)
                item.pop("project_id", None)
                return item

            items = [entry(row) for row in rows]
            for ident, change in staged_page.items():
                row = staged_rows.get(ident)
                actual = row["revision"] if row else None
                if readset[collection].get(ident) != actual:
                    raise SourceError("maintenance_read_conflict", "Staged memory changed during the Loop", 409, True)
                item = entry(row) if row else {"id": ident, "revision": None, "fact_ids": []}
                if change.action == "remove":
                    if row is None:
                        continue
                    # Retain the target identity for an explicit rebuild decision.
                    item["pending_delete"] = True
                elif change.action == "upsert":
                    item = {"id": ident, "revision": actual, **change.model_dump(exclude={"action", "id"})}
                    if collection == "events":
                        item["event_tip"] = change.content
                fields = ("content", "topic", "sub_topic") if collection == "profiles" else (
                    "content", "event_tip", "title", "summary", "keywords")
                if query and not any(query.casefold() in str(item.get(key) or "").casefold() for key in fields):
                    continue
                items.append(item)
            items.sort(key=lambda item: str(item["id"]))
            more = len(items) > limit
            items = items[:limit]

            # Hydrate one bounded page with set queries, not per-entry round trips.
            if collection == "facts":
                sources = dict(session.execute(select(memory_blobs.c.id, memory_blobs.c.source_id).where(
                    _scope(memory_blobs, self.user_id, self.project_id),
                    memory_blobs.c.id.in_({item["blob_id"] for item in items}))).all())
                for item in items:
                    item["source_id"] = sources[item["blob_id"]]
            else:
                if collection == "events":
                    links = {}
                    for eid, fid in session.execute(select(memory_event_facts.c.event_id, memory_event_facts.c.fact_id)
                        .where(_scope(memory_event_facts, self.user_id, self.project_id),
                               memory_event_facts.c.event_id.in_([_uuid(item["id"]) for item in items]))):
                        links.setdefault(str(eid), set()).add(str(fid))
                    for item in items:
                        change = staged.get(item["id"])
                        if change is None or change.action != "upsert":
                            item["fact_ids"] = sorted(set(item["fact_ids"]) | links.get(item["id"], set()))
                mentioned = {_uuid(fid) for item in items for fid in item["fact_ids"]}
                facts = {str(row["id"]): dict(row) for row in session.execute(select(
                    memory_facts.c.id, memory_facts.c.blob_id, memory_facts.c.content, memory_facts.c.subject,
                    memory_facts.c.reporter, memory_facts.c.certainty, memory_facts.c.support_groups,
                    memory_facts.c.occurred_at, memory_facts.c.fact_time, memory_facts.c.revision,
                    memory_facts.c.created_at, memory_facts.c.updated_at,
                ).where(_scope(memory_facts, self.user_id, self.project_id), memory_facts.c.id.in_(mentioned))).mappings()}
                for item in items:
                    item["support_unknown"] = not item["fact_ids"]
                    item["invalid_fact_ids"] = sorted(set(item["fact_ids"]) - facts.keys())
                    item["fact_ids"] = sorted(set(item["fact_ids"]) & facts.keys())
                    item["evidence"] = []

        # Leave room for the bounded progress preview attached on the event loop.
        accepted, size = [], 96 + self._review_progress_bytes
        for item in items:
            if collection != "facts":
                item["review_required"] = item["id"] in self._review_required[collection]
                change = staged.get(item["id"])
                if item["review_required"] and (change is None or change.action != "upsert"):
                    # Old prose can carry withdrawn claims even with valid Fact IDs.
                    # Rebuild affected entries from current support, including legacy
                    # relation-only evidence; keep only identity and classification.
                    item = {key: value for key, value in item.items() if key in (
                        "id", "revision", "topic", "fact_ids", "invalid_fact_ids", "evidence",
                        "review_required", "pending_delete", "support_unknown")}
            cost = payload_size(item) + 2
            if size + cost > MAX_TOOL_BYTES:
                if not accepted:
                    raise SourceError("maintenance_capacity", "A complete memory entry exceeds the tool budget", 413)
                break
            ident = str(item["id"])
            if readset[collection].get(ident, item["revision"]) != item["revision"]:
                raise SourceError("maintenance_read_conflict", "Memory changed during the maintenance read", 409, True)
            readset[collection][ident] = item["revision"]
            accepted.append(item)
            size += cost
        # Preserve complete entries before spending spare page space on support.
        # Keep every fact_id; omitted evidence uses the existing Fact reader.
        # Deduplicate within this page only, never across tool calls.
        returned_facts = set()
        if collection != "facts":
            for item in accepted:
                for fid in item["fact_ids"]:
                    if fid in returned_facts:
                        continue
                    fact = facts[fid]
                    cost = payload_size(fact) + 2
                    if size + cost > MAX_TOOL_BYTES:
                        continue
                    if readset["facts"].get(fid, fact["revision"]) != fact["revision"]:
                        raise SourceError("maintenance_read_conflict", "Fact changed while reading derived memory", 409, True)
                    item["evidence"].append(fact)
                    readset["facts"][fid] = fact["revision"]
                    returned_facts.add(fid)
                    size += cost
        next_cursor = str(accepted[-1]["id"]) if accepted and (more or len(accepted) < len(items)) else None
        return json.loads(json.dumps({"items": accepted, "next_cursor": next_cursor}, default=str)), readset

    def _merge_reads(self, reads):
        # SQL threads operate on private snapshots. Validate then merge without
        # yielding on the event loop, so concurrent reads cannot overwrite a conflict.
        for collection, versions in reads.items():
            for ident, revision in versions.items():
                if ident in self.readset[collection] and self.readset[collection][ident] != revision:
                    raise SourceError("maintenance_read_conflict", "Memory changed during the Loop", 409, True)
        for collection, versions in reads.items():
            self.readset[collection].update(versions)

    async def read(self, collection, *, ids=None, cursor=None, query=None, limit=100):
        await self.assert_active()
        reads = {key: dict(value) for key, value in self.readset.items()}
        staged = dict(self._staged.get(collection, {}))
        result, reads = await run_sql(self._read, collection, ids, cursor, query, limit, reads, staged)
        await self.assert_active()
        # A concurrently staged update of an entry returned by this read makes its
        # staged text stale even when the underlying DB revision has not changed.
        if any(self._staged.get(collection, {}).get(item["id"]) != staged.get(item["id"])
               for item in result["items"]):
            raise SourceError("maintenance_read_conflict", "Staged memory changed during the read", 409, True)
        self._merge_reads(reads)
        if collection in self._derived_reads:
            # Reading our own replacement is not reading the original stored text.
            self._derived_reads[collection].update(item["id"] for item in result["items"]
                if item["id"] not in staged or staged[item["id"]].action != "upsert")
        return {**result, "remaining_review": self._remaining_review()}

    async def search(self, query, *, limit=20):
        from .event import hybrid_search_user_events
        await self.assert_active()
        result = await hybrid_search_user_events(self.user_id, self.project_id, query, limit=limit,
                                                include_pending_derived=True)
        if not result.ok():
            raise SourceError("maintenance_search_unavailable", "Memory search did not complete", 503,
                              result.code() in {429, 500, 502, 503, 504})
        collections = {collection: [] for collection in ("facts", "profiles", "events")}
        ranked = [(collection, getattr(result.data(), collection)) for collection in collections
                  if getattr(result.data(), collection)]
        # Hydrate independent collections concurrently; each read owns its SQL
        # session and validates current versions/staged overlays. Join all reads
        # before propagating a failure, so none outlives the failed search.
        pages = await asyncio.gather(*(self.read(collection, ids=[str(item.id) for item in entries], limit=limit)
                                      for collection, entries in ranked), return_exceptions=True)
        for (collection, entries), page in zip(ranked, pages, strict=True):
            if isinstance(page, BaseException):
                raise page
            items = page["items"]
            by_id = {item["id"]: item for item in items}
            collections[collection] = [dict(by_id[str(item.id)], score=item.score)
                                       for item in entries if str(item.id) in by_id]
        returned_facts = {item["id"] for item in collections["facts"]}
        for collection in ("profiles", "events"):
            for item in collections[collection]:
                item["evidence"] = [fact for fact in item["evidence"] if fact["id"] not in returned_facts]
                returned_facts.update(fact["id"] for fact in item["evidence"])
        await self.assert_active()
        return collections

    def _validate_stage(self, change, kind):
        collection = "profiles" if kind == "profile" else "events"
        staged = self._staged[collection]
        if change.id is not None:
            ident = str(_uuid(change.id))
            if ident not in self.readset[collection]:
                raise SourceError("maintenance_target_unread", "Read the target entry before changing it", 502)
            if (self.readset[collection][ident] is None and ident not in staged
                    and (kind, ident) not in self._unresolved_staging):
                raise SourceError("maintenance_target_absent", "Cannot replace an absent entry with a supplied id", 502)
            if (ident not in self._derived_reads[collection]
                    and (change.action == "keep" or self.readset[collection][ident] is not None)):
                raise SourceError("maintenance_target_unread", "Read the complete target before deciding its content", 502)
            if change.action == "keep" and ident in self._review_required[collection]:
                raise SourceError("maintenance_rewrite_required", "Rebuild affected memory from current Facts or remove it", 502)
        if change.action == "upsert":
            if kind == "profile" and change.topic not in self.allowed_topics:
                raise SourceError("maintenance_invalid_topic", "Profile topic is outside the configured topics", 502)
            if kind == "event":
                allowed_tags = {definition["name"] for definition in self.event_tag_definitions}
                if any(tag.tag not in allowed_tags for tag in change.event_tags):
                    raise SourceError("maintenance_invalid_tag", "Event tag is outside the configured tags", 502)
            return {str(_uuid(fid)) for fid in change.fact_ids
                    if self.readset["facts"].get(str(_uuid(fid))) is None}
        return set()

    async def stage_batch(self, changes, kind):
        """Reject the whole batch before staging; keep rejected targets unresolved."""
        from ..env import LOG
        await self.assert_active()
        missing = set().union(*(self._validate_stage(change, kind) for change in changes))
        keep_ids = [_uuid(change.id) for change in changes if change.action == "keep"]
        keep_support = {}
        if keep_ids:
            def read_support():
                from ..models.database import UserProfile, UserEvent
                table = UserProfile.__table__ if kind == "profile" else UserEvent.__table__
                with Session() as session:
                    return _entry_support(session, table, "profiles" if kind == "profile" else "events",
                                          self.claim, keep_ids)
            keep_support = await run_sql(read_support)
            await self.assert_active()
            missing.update(fid for support in keep_support.values() for fid in support
                           if self.readset["facts"].get(fid) is None)
        empty_support = any(not keep_support.get(str(ident)) for ident in keep_ids)
        invalid = {ident for ident in missing if ident in self.readset["facts"]}
        unread = missing - invalid
        if missing or empty_support:
            collection = "profiles" if kind == "profile" else "events"
            ids = []
            rejections = {}
            for change in changes:
                ident = str(_uuid(change.id)) if change.id is not None else str(uuid4())
                # A corrected create uses its reserved id. Compare the same target
                # and full proposal, with read evidence, rather than its null input id.
                proposal = change.model_dump(mode="json")
                proposal["id"] = ident
                proposal["fact_ids"] = sorted(proposal["fact_ids"])
                support = [(fid, self.readset["facts"].get(fid, "unread"))
                           for fid in sorted(keep_support.get(ident, proposal["fact_ids"]))]
                signature = (proposal, support) if any(revision in (None, "unread")
                                                     for _, revision in support) or (change.action == "keep" and not support) else None
                if signature is not None and self._unresolved_staging.get((kind, ident)) == signature:
                    raise SourceError("maintenance_staging_repeated", "Rejected change was repeated without new evidence or correction", 502)
                if signature is not None or (kind, ident) not in rejections:
                    rejections[(kind, ident)] = signature
                ids.append(ident)
            for change, ident in zip(changes, ids, strict=True):
                if change.id is None:
                    # Reserve only a run-local identity for correcting this create;
                    # no draft or database row is saved.
                    self.readset[collection][ident] = None
            self._unresolved_staging.update(rejections)
            LOG.warning("Maintenance support rejected: operation=%s kind=%s target_ids=%s unread_fact_ids=%s invalid_fact_ids=%s read_fact_count=%s",
                        self.operation_id, kind, ids[:20], sorted(unread)[:20], sorted(invalid)[:20], len(self.readset["facts"]))
            return {"staged": False, "ids": ids,
                    "remaining_review": self._remaining_review(),
                    "error": {"code": "maintenance_support_invalid" if invalid or empty_support else "maintenance_support_unread",
                              "unread_fact_ids": sorted(unread), "invalid_fact_ids": sorted(invalid)}}
        stage = self.stage_profile if kind == "profile" else self.stage_event
        ids = [await stage(change) for change in changes]
        return {"staged": True, "ids": ids, "remaining_review": self._remaining_review()}

    async def _stage(self, change, kind):
        await self.assert_active()
        missing = self._validate_stage(change, kind)
        if missing:
            code = "maintenance_support_invalid" if any(fid in self.readset["facts"] for fid in missing) else "maintenance_support_unread"
            raise SourceError(code, "Read valid supporting facts before staging memory", 502)
        collection = "profiles" if kind == "profile" else "events"
        ident = str(_uuid(change.id)) if change.id is not None else str(uuid4())
        if change.id is None:
            change = change.model_copy(update={"id": ident})
            self.readset[collection][ident] = None
        self._staged[collection][ident] = change
        self._unresolved_staging.pop((kind, ident), None)
        return ident

    async def stage_profile(self, change):
        return await self._stage(change, "profile")

    async def stage_event(self, change):
        return await self._stage(change, "event")

    def _read_changes(self, cursor, limit, reads):
        from ..maintenance_agent import MAX_PAGE_SIZE, MAX_TOOL_BYTES
        from ..models.source import memory_facts
        if not 1 <= limit <= MAX_PAGE_SIZE:
            raise SourceError("invalid_model_output", "Invalid change page", 502)
        candidates = self.changes[cursor:cursor + limit]
        ids = {_uuid(change["fact_id"]) for change in candidates if change.get("fact_id")}
        with Session() as session:
            assert_user_active(session, self.user_id, self.project_id)
            current = {str(row["id"]): dict(row) for row in session.execute(select(
                memory_facts.c.id, memory_facts.c.blob_id, memory_facts.c.content, memory_facts.c.subject,
                memory_facts.c.reporter, memory_facts.c.certainty, memory_facts.c.revision,
                memory_facts.c.support_groups, memory_facts.c.occurred_at, memory_facts.c.fact_time,
                memory_facts.c.created_at, memory_facts.c.updated_at,
            ).where(_scope(memory_facts, self.user_id, self.project_id), memory_facts.c.id.in_(ids))).mappings()}
        items, size = [], 64 + self._review_progress_bytes
        for change in candidates:
            ident = str(_uuid(change["fact_id"])) if change.get("fact_id") else None
            fact = current.get(ident)
            item = {**change, "current_fact": fact}
            cost = payload_size(item) + 2
            if size + cost > MAX_TOOL_BYTES:
                if not items:
                    raise SourceError("maintenance_capacity", "A complete Fact change exceeds the tool budget", 413)
                break
            if ident:
                revision = fact["revision"] if fact else None
                if ident in reads and reads[ident] != revision:
                    raise SourceError("maintenance_read_conflict", "Fact changed during the Loop", 409, True)
                reads[ident] = revision
            items.append(item)
            size += cost
        end = cursor + len(items)
        return json.loads(json.dumps({"items": items,
            "next_cursor": str(end) if end < len(self.changes) else None}, default=str)), reads

    async def read_changes(self, *, cursor=None, limit=100):
        await self.assert_active()
        try:
            offset = int(cursor or "0")
        except (ValueError, TypeError):
            raise SourceError("invalid_model_output", "Invalid change cursor", 502) from None
        if offset < 0 or offset > len(self.changes):
            raise SourceError("invalid_model_output", "Invalid change page", 502)
        result, reads = await run_sql(self._read_changes, offset, limit, dict(self.readset["facts"]))
        await self.assert_active()
        self._merge_reads({"facts": reads})
        self._seen_changes.update(range(offset, offset + len(result["items"])))
        return {**result, "remaining_review": self._remaining_review()}

    def get_plan(self, usage):
        from ..maintenance_agent import LoopPlan
        if self._unresolved_staging:
            raise SourceError("maintenance_unresolved_staging", "Rejected memory changes must be corrected before completion", 502)
        if any(group["count"] for group in self._remaining_review().values()):
            raise SourceError("maintenance_unresolved_entries", "Required memory decisions remain outstanding", 502)
        if any(index not in self._seen_changes for index, change in enumerate(self.changes)
               if change.get("kind") != "noop"):
            raise SourceError("maintenance_incomplete", "Not all fixed Fact changes were reviewed", 502, True)
        return LoopPlan(list(self._staged["profiles"].values()), list(self._staged["events"].values()),
                        {key: dict(value) for key, value in self.readset.items()}, usage,
                        {key: set(value) for key, value in self._derived_reads.items()})


def _verify_readset(session, claim, readset):
    from ..models.database import UserProfile, UserEvent
    from ..models.source import memory_facts
    tables = {"facts": memory_facts, "profiles": UserProfile.__table__, "events": UserEvent.__table__}
    for collection, reads in readset.items():
        if not reads:
            continue
        table = tables[collection]
        current = {str(ident): revision for ident, revision in session.execute(select(table.c.id, table.c.revision)
            .where(_scope(table, claim.user_id, claim.project_id), table.c.id.in_([_uuid(ident) for ident in reads]))
            .order_by(table.c.id).with_for_update())}
        for ident, revision in reads.items():
            if current.get(ident) != revision:
                raise SourceError("maintenance_read_conflict", "Related memory changed while the Loop was computed", 409, True)


def _associated_entries(table, collection, user_id, project_id, fact_ids, *, include_unknown=False):
    from ..models.source import memory_event_facts
    data = table.c.attributes if collection == "profiles" else table.c.event_data
    matches = [data.contains({"fact_ids": [str(ident)]}) for ident in fact_ids]
    if fact_ids:
        matches.append(affected(data, fact_ids, include_unknown=include_unknown))
    if collection == "events" and fact_ids:
        # FK cascade removes a deleted Fact's relational edge, so the previously
        # saved identity list also locates its now-stale story.
        matches.extend(data.contains({"evidence": [{"fact_id": str(ident)}]}) for ident in fact_ids)
        matches.append(table.c.id.in_(select(memory_event_facts.c.event_id).where(
            _scope(memory_event_facts, user_id, project_id), memory_event_facts.c.fact_id.in_(fact_ids))))
    return or_(*matches) if matches else table.c.id.in_([])


def _entry_support(session, table, collection, claim, ids):
    """Known support identities, including legacy JSON and surviving relation edges."""
    from ..models.source import memory_event_facts
    data = table.c.attributes if collection == "profiles" else table.c.event_data
    result = {}
    for ident, value in session.execute(select(table.c.id, data).where(
            _scope(table, claim.user_id, claim.project_id), table.c.id.in_(ids))):
        value = value or {}
        result[str(ident)] = set(value.get("fact_ids") or [])
        if collection == "events":
            result[str(ident)].update(item["fact_id"] for item in (value.get("evidence") or [])
                                     if isinstance(item, dict) and item.get("fact_id"))
    if collection == "events":
        for eid, fid in session.execute(select(memory_event_facts.c.event_id, memory_event_facts.c.fact_id).where(
                _scope(memory_event_facts, claim.user_id, claim.project_id), memory_event_facts.c.event_id.in_(ids))):
            result[str(eid)].add(str(fid))
    return result


def _verify_resolution(session, claim, plan, kind):
    from ..models.database import UserProfile, UserEvent
    # Reading is not a decision: every candidate needs keep/upsert/remove.
    changed_ids = [_uuid(change["fact_id"]) for change in claim.changes
                   if change.get("fact_id") and change.get("kind") != "added"]
    if not changed_ids:
        return
    collection = "profiles" if kind == "profile" else "events"
    table = UserProfile.__table__ if kind == "profile" else UserEvent.__table__
    affected = set(map(str, session.scalars(select(table.c.id).where(
        _scope(table, claim.user_id, claim.project_id),
        _associated_entries(table, collection, claim.user_id, claim.project_id, changed_ids,
                            include_unknown=True)))))
    resolved = {str(_uuid(change.id)) for change in getattr(plan, collection)}
    if affected - resolved:
        raise SourceError("maintenance_unresolved_entries", "Changed evidence still has unreviewed derived entries", 502)
    if any(change.action == "keep" and str(_uuid(change.id)) in affected
           for change in getattr(plan, collection)):
        raise SourceError("maintenance_rewrite_required", "Rebuild affected memory from current Facts or remove it", 502)


def _plan_impact(session, claim, plan):
    """Read original, already version-locked entries before either collection is written."""
    from ..models.database import UserProfile, UserEvent
    from ..models.source import memory_facts
    impact = {ident for ident, revision in plan.readset["facts"].items() if revision is not None}
    for collection, table, data in (("profiles", UserProfile.__table__, UserProfile.attributes),
                                    ("events", UserEvent.__table__, UserEvent.event_data)):
        # Automatic removal targets are version-checked, but their unread text
        # must not contaminate the impact of newly generated entries.
        ids = [_uuid(ident) for ident in plan.derived_reads[collection]
               if plan.readset[collection].get(ident) is not None]
        if not ids:
            continue
        for inherited in session.scalars(select(data[IMPACT_KEY]).where(
                _scope(table, claim.user_id, claim.project_id), table.c.id.in_(ids))):
            if inherited is None:
                # An old incomplete association cannot become complete merely by
                # being copied into a newly generated entry.
                return None
            impact.update(inherited)
    # Pending text may still carry a deletion owned by another sealed flush.
    # Drop only deletions this batch handles; otherwise its later cleanup would
    # miss newly derived entries. Keep a currently present Fact even on recovery.
    deleted_here = {change["fact_id"] for change in claim.changes if change.get("kind") == "deleted"}
    if deleted_here:
        current = set(map(str, session.scalars(select(memory_facts.c.id).where(
            _scope(memory_facts, claim.user_id, claim.project_id),
            memory_facts.c.id.in_([_uuid(fid) for fid in deleted_here])))))
        impact.difference_update(deleted_here - current)
    return sorted(impact)


def _apply_plan(session, claim, plan, kind, event_embeddings, impact):
    changes = plan.profiles if kind == "profile" else plan.events
    # Keep never rewrites text, provenance, vectors, timestamps or history.
    from ..models.database import UserProfile, UserEvent
    collection = "profiles" if kind == "profile" else "events"
    table = UserProfile.__table__ if kind == "profile" else UserEvent.__table__
    kept = [_uuid(change.id) for change in changes if change.action == "keep"]
    if kept:
        support = _entry_support(session, table, collection, claim, kept)
        for ident in map(str, kept):
            if ident not in plan.derived_reads[collection] or ident not in support:
                raise SourceError("maintenance_target_unread", "Read the complete target before keeping it", 502)
            if not support[ident] or any(plan.readset["facts"].get(fid) is None for fid in support[ident]):
                raise SourceError("maintenance_support_unread", "Keep requires all original support to be valid and read; otherwise update or remove", 502)
    changes = [change for change in changes if change.action != "keep"]
    if not changes:
        return
    from ..models.source import (memory_facts, memory_blobs, memory_event_facts,
                                memory_deleted_events, memory_profile_revisions)
    from .source import _profile_snapshot, _project_rules, _history_profiles
    before = _profile_snapshot(session, claim.user_id, claim.project_id) if kind == "profile" else []
    if kind == "profile":
        unfinished = select(operations.c.id).where(operations.c.kind == "flush", operations.c.status != "completed")
        pending = [(bid, change) for bid, batch in session.execute(select(
            blobs.c.flush_operation_id, blobs.c.fact_changes).where(
            _scope(blobs, claim.user_id, claim.project_id), blobs.c.fact_completed_at.is_not(None),
            or_(blobs.c.flush_operation_id.is_(None), blobs.c.flush_operation_id.in_(unfinished))))
            for change in batch]
        # Migration-owned changes have no new Blob; until their flush succeeds
        # they must protect history just like ordinary pending message changes.
        pending.extend((op_id, change) for op_id, request in session.execute(select(
            operations.c.id, operations.c.request).where(
            _scope(operations, claim.user_id, claim.project_id), operations.c.kind == "flush",
            operations.c.status != "completed")) for change in request.get("legacy_changes", []))
        # Stale delayed text can be read, but cannot re-enter historical snapshots.
        invalid = {change["fact_id"] for _, change in pending
                   if change.get("fact_id") and change["kind"] != "added"}
        before = _history_profiles(before, invalid)
        future_invalid = {change["fact_id"] for bid, change in pending
                          if bid != claim.operation_id and change.get("fact_id") and change["kind"] != "added"}
    rules = _project_rules(session, claim.project_id)
    topics = {topic["topic"] for topic in rules["profile_topics"]}
    tags = {definition["name"] for definition in (rules["event_tag_definitions"] or [])}
    table = UserProfile.__table__ if kind == "profile" else UserEvent.__table__
    target_ids = [_uuid(change.id) for change in changes]
    existing_rows = {row["id"]: dict(row) for row in session.execute(select(table).where(
        _scope(table, claim.user_id, claim.project_id), table.c.id.in_(target_ids))).mappings()}
    support_ids = {_uuid(fid) for change in changes for fid in change.fact_ids}
    support_rows = {str(row["id"]): dict(row) for row in session.execute(select(memory_facts, memory_blobs.c.source_id)
        .join(memory_blobs, memory_facts.c.blob_id == memory_blobs.c.id)
        .where(_scope(memory_facts, claim.user_id, claim.project_id), memory_facts.c.id.in_(support_ids))).mappings()}
    deleted_events = set(session.scalars(select(memory_deleted_events.c.id).where(
        _scope(memory_deleted_events, claim.user_id, claim.project_id),
        memory_deleted_events.c.id.in_(target_ids)))) if kind == "event" else set()
    for change in changes:
        ident = _uuid(change.id)
        collection = "profiles" if kind == "profile" else "events"
        if str(ident) not in plan.readset[collection]:
            raise SourceError("maintenance_target_unread", "Maintenance target was not registered in the read set", 502)
        if any(plan.readset["facts"].get(str(_uuid(value))) is None for value in change.fact_ids):
            raise SourceError("maintenance_support_unread", "Maintenance support was not read as valid Fact evidence", 502)
        existing = existing_rows.get(ident)
        if ident in deleted_events:
            raise SourceError("maintenance_read_conflict", "Event was explicitly deleted", 409, True)
        if change.action == "remove":
            session.execute(delete(table).where(_scope(table, claim.user_id, claim.project_id), table.c.id == ident))
            continue
        # Configuration may have changed while the model was running. Validate
        # against current definitions, not only the Loop's original directory.
        if kind == "profile" and change.topic not in topics:
            raise SourceError("maintenance_read_conflict", "Configured profile topics changed", 409, True)
        if kind == "event" and any(tag.tag not in tags for tag in change.event_tags):
            raise SourceError("maintenance_read_conflict", "Configured event tags changed", 409, True)
        supported = [support_rows[str(_uuid(value))] for value in change.fact_ids if str(_uuid(value)) in support_rows]
        if len(supported) != len(change.fact_ids):
            raise SourceError("maintenance_read_conflict", "Supporting facts are no longer valid", 409, True)
        sources = sorted({fact["source_id"] for fact in supported})
        revision = 1 if existing is None else existing["revision"] + 1
        if kind == "profile":
            attributes = {**(existing["attributes"] or {} if existing else {}), "memoia_v2": True,
                          "topic": change.topic, "sub_topic": change.sub_topic,
                          "fact_ids": sorted(change.fact_ids), "source_ids": sources,
                          IMPACT_KEY: impact}
            values = {"content": change.content, "attributes": attributes, "revision": revision}
        else:
            blob_ids = sorted({str(fact["blob_id"]) for fact in supported})
            values = {"event_data": {"memoia_v2": True, "event_tip": change.content,
                       **change.model_dump(exclude={"action", "id"}), "source_ids": sources,
                       "blob_ids": blob_ids, "source_id": sources[0] if len(sources) == 1 else None,
                       "blob_id": blob_ids[0] if len(blob_ids) == 1 else None, IMPACT_KEY: impact},
                      "embedding": event_embeddings[ident], "revision": revision}
        if existing is None:
            session.execute(table.insert().values(id=ident, user_id=claim.user_id,
                project_id=claim.project_id, **values))
        else:
            session.execute(update(table).where(_scope(table, claim.user_id, claim.project_id),
                table.c.id == ident).values(**values, updated_at=func.now()))
        if kind == "event":
            session.execute(delete(memory_event_facts).where(
                _scope(memory_event_facts, claim.user_id, claim.project_id), memory_event_facts.c.event_id == ident))
            session.execute(memory_event_facts.insert(), [{"event_id": ident, "fact_id": fact["id"],
                "user_id": claim.user_id, "project_id": claim.project_id} for fact in supported])
    if kind == "profile" and changes:
        # A newer correction/retraction can arrive during this Loop. Its stale current text is
        # allowed until the next flush, but must never be restored into history.
        after = _history_profiles(_profile_snapshot(session, claim.user_id, claim.project_id), future_invalid)
        before_by_id = {row["id"]: row for row in before}
        after_by_id = {row["id"]: row for row in after}
        session.execute(insert(memory_profile_revisions).values(
            id=uuid4(), user_id=claim.user_id, project_id=claim.project_id,
            operation_id=claim.operation_id, source_id=None, maintenance_version=None,
            profiles=after, added=[row for ident, row in after_by_id.items() if before_by_id.get(ident) != row],
            removed=[row for ident, row in before_by_id.items() if after_by_id.get(ident) != row],
        ))


async def _prepare_event_embeddings(claim, plan):
    from ..env import CONFIG
    from ..models.database import UserEvent
    from ..models.response import EventData
    from ..llms.embeddings import get_embedding
    from ..utils import event_embedding_str

    changes = [change for change in plan.events if change.action == "upsert"]
    if not changes:
        return {}
    if not CONFIG.enable_event_embedding:
        return {_uuid(change.id): None for change in changes}

    def read_existing():
        with Session() as session:
            return {row.id: (event_embedding_str(EventData(**row.event_data)), row.embedding)
                    for row in session.scalars(select(UserEvent).where(
                        UserEvent.user_id == claim.user_id, UserEvent.project_id == claim.project_id,
                        UserEvent.id.in_([_uuid(change.id) for change in changes])))}

    existing = await run_sql(read_existing)
    prepared, pending = {}, {}
    for change in changes:
        ident = _uuid(change.id)
        content = event_embedding_str(EventData(**change.model_dump()))
        previous = existing.get(ident)
        if previous is not None and previous[0] == content and previous[1] is not None:
            prepared[ident] = previous[1]
        else:
            pending[ident] = content
    if pending:
        result = await get_embedding(claim.project_id, list(pending.values()), phase="document")
        if not result.ok():
            retryable = result.code() in {429, 500, 502, 503, 504}
            raise SourceError("maintenance_embedding_failed", "Event index generation failed", result.code(), retryable)
        prepared.update(zip(pending, result.data(), strict=True))
    return prepared


def _commit_plan(claim, plan, lease, task_lease, model_config, event_embeddings):
    from ..models.database import Project
    from .source import _fence_snapshot, fence_commit, _project_rules
    with Session.begin() as session:
        task_lease.check_active()
        _fence_snapshot(session, claim.user_id, claim.project_id, lease)
        assert_claim(session, claim)
        # Keep configuration stable only for this short commit, not model work.
        session.execute(select(Project.project_id).where(Project.project_id == claim.project_id)
                        .with_for_update(read=True)).scalar_one()
        current = _project_rules(session, claim.project_id)
        if (current["llm_model"], current["reasoning_effort"]) != model_config:
            raise SourceError("maintenance_read_conflict", "Project model configuration changed during maintenance", 409, True)
        _verify_readset(session, claim, plan.readset)
        for kind in ("profile", "event"):
            _verify_resolution(session, claim, plan, kind)
        impact = _plan_impact(session, claim, plan)
        for kind in ("profile", "event"):
            _apply_plan(session, claim, plan, kind, event_embeddings, impact)
        fence_commit(session, claim.user_id, claim.project_id, lease)
        task_lease.check_active()
        complete_flush(session, claim, plan)


async def execute_claim(claim: Claim, *, runner=None):
    from ..env import LOG
    from ..maintenance_agent import run_loop, LoopUsage
    from .user_lease import UserLease, LeaseUnavailable, LeaseLost
    runner = runner or run_loop
    async with TaskLease(claim) as task_lease:
        try:
            context = await run_sql(DBMaintenanceContext, claim, task_lease)
            plan = context.get_plan(LoopUsage()) if all(
                change.get("kind") == "noop" for change in claim.changes) else await runner(context)
            await task_lease.assert_active()
            # Network work precedes the short write lease/transaction. The read
            # set is still checked at commit, including any reused event vector.
            event_embeddings = await _prepare_event_embeddings(claim, plan)
            await task_lease.assert_active()
            deadline = time.monotonic() + 30
            while True:
                try:
                    async with UserLease(claim.user_id, claim.project_id) as lease:
                        await run_sql(_commit_plan, claim, plan, lease, task_lease,
                                          (context.llm_model, context.reasoning_effort), event_embeddings)
                    break
                except LeaseUnavailable:
                    await task_lease.assert_active()
                    if time.monotonic() >= deadline:
                        raise SourceError("lease_unavailable", "Memory writer is still busy", 409, True) from None
                    await asyncio.sleep(.1)
            LOG.info("Flush committed: operation=%s turns=%s input_tokens=%s output_tokens=%s usage_complete=%s elapsed_seconds=%.3f",
                     claim.operation_id, plan.usage.turns, plan.usage.input_tokens,
                     plan.usage.output_tokens, plan.usage.usage_complete, plan.usage.elapsed_seconds)
        except asyncio.CancelledError:
            await run_sql(fail_claim, claim, SourceError("maintenance_cancelled", "Flush was interrupted", 503, True))
            raise
        except Exception as error:
            if isinstance(error, LeaseLost):
                error = SourceError("lease_lost", "Memory write ownership was lost", 409, True)
            await run_sql(fail_claim, claim, error)
            return False
    return True
