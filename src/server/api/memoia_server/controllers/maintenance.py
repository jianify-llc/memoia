"""Fixed Blob batches; Operations own flush scheduling, receipts and execution."""

import asyncio
import json
import time
from contextlib import suppress
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from uuid import UUID, uuid4

from sqlalchemy import JSON, and_, delete, func, or_, select, update, exists
from sqlalchemy.dialects.postgresql import insert

from ..connectors import Session
from ..models.source import memory_operations as operations, memory_blobs as blobs
from ..models.database import User
from ..utils import json_size as payload_size
from .source import SourceError, _scope, _hash, assert_user_active, lock_user_identity

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


def _unassigned(user_id, project_id):
    return and_(_scope(blobs, user_id, project_id), blobs.c.fact_completed_at.is_not(None),
                blobs.c.flush_operation_id.is_(None))


def _change_size(session, user_id, project_id, changes):
    from ..models.source import memory_facts
    fact_ids = {_uuid(change["fact_id"]) for change in changes if change.get("fact_id")}
    facts = [dict(row) for row in session.execute(select(
        memory_facts.c.id, memory_facts.c.content, memory_facts.c.subject,
        memory_facts.c.reporter, memory_facts.c.certainty, memory_facts.c.support_groups,
        memory_facts.c.occurred_at, memory_facts.c.event_time,
    ).where(_scope(memory_facts, user_id, project_id), memory_facts.c.id.in_(fact_ids),
            memory_facts.c.active.is_(True))).mappings()]
    return payload_size({"changes": changes, "facts": facts})


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
    batch_ids, used, oversized = [], 0, False
    for bid, changes in candidates:
        cost = _change_size(session, user_id, project_id, changes)
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
        kind="flush", request_hash=request_hash, request={"blob_ids": list(map(str, batch_ids))},
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
        if not await asyncio.to_thread(renew_claim, self.claim, lease_seconds=self.ttl):
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
                    owned = await asyncio.to_thread(renew_claim, self.claim, lease_seconds=self.ttl)
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
        self.user_id, self.project_id = claim.user_id, claim.project_id
        self.through_version, self.changes = claim.through_version, claim.changes
        self.blob_count = len(claim.blob_ids)
        with Session() as session:
            # Recovery reads current Facts, so a formerly small batch may have
            # grown. Keep the sealed identity, but reject unbounded model work.
            if _change_size(session, self.user_id, self.project_id, self.changes) > MAX_FLUSH_BYTES:
                raise SourceError("maintenance_capacity", "Fixed Blob changes exceed the flush budget", 413)
            rules = _project_rules(session, self.project_id)
        self.profile_topics = rules["profile_topics"]
        self.allowed_topics = [topic["topic"] for topic in self.profile_topics]
        self.event_tag_definitions = rules["event_tag_definitions"] or []
        self.language = rules["language"]
        self.llm_model = rules["llm_model"]
        self.reasoning_effort = rules["reasoning_effort"]
        self.readset = {"facts": {}, "profiles": {}, "events": {}}
        self._staged = {"profiles": {}, "events": {}}
        self._seen_changes = set()
        self._prepare_unsupported()

    def _prepare_unsupported(self):
        from ..models.database import UserProfile, UserEvent
        from ..models.source import memory_facts, memory_event_facts
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
                data = table.c.attributes if collection == "profiles" else table.c.event_data
                rows = session.execute(select(table.c.id, table.c.revision,
                    data["fact_ids"].label("fact_ids"), data["evidence"].label("evidence"))
                    .where(_scope(table, self.user_id, self.project_id),
                           _associated_entries(table, collection, self.user_id, self.project_id, changed_ids))).mappings().all()
                links = {}
                if collection == "events" and rows:
                    for eid, fid in session.execute(select(memory_event_facts.c.event_id, memory_event_facts.c.fact_id)
                        .where(_scope(memory_event_facts, self.user_id, self.project_id),
                               memory_event_facts.c.event_id.in_([row["id"] for row in rows]))):
                        links.setdefault(eid, set()).add(str(fid))
                supported = {row["id"]: set(row["fact_ids"] or []) | links.get(row["id"], set()) |
                    {proof["fact_id"] for proof in (row["evidence"] or [])
                     if isinstance(proof, dict) and proof.get("fact_id")} for row in rows}
                ids = {_uuid(ident) for values in supported.values() for ident in values}
                active = set(map(str, session.scalars(select(memory_facts.c.id).where(
                    _scope(memory_facts, self.user_id, self.project_id), memory_facts.c.id.in_(ids),
                    memory_facts.c.active.is_(True)))))
                for row in rows:
                    proof_ids = supported[row["id"]]
                    # An empty legacy/manual association proves nothing. Only a
                    # known Fact-backed entry with no surviving support is mechanical.
                    if not proof_ids or proof_ids & active:
                        continue
                    ident = str(row["id"])
                    self.readset[collection][ident] = row["revision"]
                    self.readset["facts"].update({str(_uuid(fid)): None for fid in proof_ids})
                    self._staged[collection][ident] = mutation(action="remove", id=ident)

    async def assert_active(self):
        await self.lease.assert_active()

    def _read(self, collection, ids, cursor, query, limit):
        from ..models.database import UserProfile, UserEvent
        from ..models.source import memory_facts, memory_blobs, memory_event_facts
        from .source import assert_user_active
        tables = {"facts": memory_facts, "profiles": UserProfile.__table__, "events": UserEvent.__table__}
        if collection not in tables:
            raise SourceError("invalid_model_output", "Unsupported memory collection", 502)
        from ..maintenance_agent import MAX_PAGE_SIZE, MAX_TOOL_BYTES
        original_reads = {key: dict(value) for key, value in self.readset.items()}
        if not 1 <= limit <= MAX_PAGE_SIZE or (ids is not None and len(ids) > MAX_PAGE_SIZE):
            raise SourceError("invalid_model_output", "Memory page limit exceeded", 502)
        try:
            offset = int(cursor or "0")
        except (ValueError, TypeError):
            raise SourceError("invalid_model_output", "Memory page cursor is invalid", 502) from None
        if offset < 0 or offset > 10000 or (query and len(query) > 500):
            raise SourceError("invalid_model_output", "Memory page cursor or query exceeds limit", 502)
        staged = self._staged.get(collection, {})
        table = tables[collection]
        statement = select(table).where(_scope(table, self.user_id, self.project_id))
        removed = [ident for ident, change in staged.items() if change.action == "remove"]
        if removed:
            statement = statement.where(table.c.id.not_in([_uuid(ident) for ident in removed]))
        changed_ids = [_uuid(change["fact_id"]) for change in self.changes if change.get("fact_id")]
        if collection == "facts":
            statement = statement.where(table.c.active.is_(True))
        if ids is None and not query:
            if collection == "facts":
                statement = statement.where(table.c.id.in_(changed_ids))
            else:
                statement = statement.where(_associated_entries(
                    table, collection, self.user_id, self.project_id, changed_ids))
        if ids is not None:
            statement = statement.where(table.c.id.in_([_uuid(value) for value in ids]))
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
                    .offset(offset).limit(limit + 1)).mappings()]
            more = len(rows) > limit
            rows = rows[:limit]
            staged_offset = 0
            if collection != "facts" and not more:
                count = session.scalar(select(func.count()).select_from(statement.subquery()))
                staged_offset = max(0, offset - count)
            found = {str(row["id"]) for row in rows}
            if ids is not None:
                present = set(map(str, session.scalars(select(table.c.id).where(
                    _scope(table, self.user_id, self.project_id), table.c.id.in_([_uuid(value) for value in ids]),
                    table.c.active.is_(True) if collection == "facts" else True))))
                for ident in ids:
                    if str(_uuid(ident)) not in present:
                        self.readset[collection][str(_uuid(ident))] = None
            items = []
            for row in rows:
                ident = str(row["id"])
                previous = self.readset[collection].get(ident, row["revision"])
                if previous != row["revision"]:
                    raise SourceError("maintenance_read_conflict", "Memory changed during the maintenance read", 409, True)
                self.readset[collection][ident] = row["revision"]
                if collection == "facts":
                    source_id = session.scalar(select(memory_blobs.c.source_id).where(
                        memory_blobs.c.id == row["blob_id"], _scope(memory_blobs, self.user_id, self.project_id)))
                    item = {**row, "source_id": source_id}
                    for key in ("embedding", "search_text", "included"):
                        item.pop(key, None)
                elif collection == "profiles":
                    attributes = row["attributes"] or {}
                    item = {"id": ident, "content": row["content"], "revision": row["revision"],
                            "topic": attributes.get("topic", ""), "sub_topic": attributes.get("sub_topic", ""),
                            "fact_ids": attributes.get("fact_ids", [])}
                    if ids is None:
                        item["content_preview"] = item.pop("content")[:500]
                else:
                    linked = list(session.scalars(select(memory_event_facts.c.fact_id).where(
                        memory_event_facts.c.event_id == row["id"],
                        _scope(memory_event_facts, self.user_id, self.project_id))))
                    # Legacy JSON retains identity only. Its old evidence text is
                    # never reintroduced as valid Fact support after withdrawal.
                    legacy_ids = [value["fact_id"] for value in (row["event_data"].get("evidence") or [])
                                  if isinstance(value, dict) and value.get("fact_id")]
                    item = {**row["event_data"], "id": ident, "revision": row["revision"],
                            "fact_ids": list({*map(str, linked), *row["event_data"].get("fact_ids", []), *legacy_ids})}
                    item.pop("evidence", None)
                    if ids is None:
                        for key in ("content", "event_tip", "interpretation"):
                            item.pop(key, None)
                if collection != "facts":
                    mentioned = [_uuid(value) for value in item["fact_ids"]]
                    valid = set(map(str, session.scalars(select(memory_facts.c.id).where(
                        _scope(memory_facts, self.user_id, self.project_id), memory_facts.c.id.in_(mentioned),
                        memory_facts.c.active.is_(True)))))
                    item["invalid_fact_ids"] = sorted(set(item["fact_ids"]) - valid)
                    item["fact_ids"] = sorted(valid)
                    if collection == "events" and ids is not None:
                        evidence = []
                        for fact in session.execute(select(memory_facts).where(
                            _scope(memory_facts, self.user_id, self.project_id),
                            memory_facts.c.id.in_([_uuid(value) for value in valid]))).mappings():
                            fact_id = str(fact["id"])
                            expected = self.readset["facts"].get(fact_id, fact["revision"])
                            if expected != fact["revision"]:
                                raise SourceError("maintenance_read_conflict", "Fact changed while reading the event", 409, True)
                            self.readset["facts"][fact_id] = fact["revision"]
                            evidence.append({key: fact[key] for key in (
                                "id", "blob_id", "content", "subject", "reporter", "certainty",
                                "support_groups", "occurred_at", "event_time")})
                        item["evidence"] = evidence
                # Every returned identity is server-scoped; model arguments cannot
                # switch user/project even when a guessed id exists elsewhere.
                item.pop("user_id", None)
                item.pop("project_id", None)
                if ident in staged and staged[ident].action == "remove":
                    continue
                if ident in staged:
                    item.update(staged[ident].model_dump())
                items.append(item)
        if collection != "facts" and not more:
            additions = []
            for ident, change in sorted(staged.items()):
                if change.action == "remove" or ident in found or self.readset[collection].get(ident) is not None:
                    continue
                if ids is not None and ident not in ids:
                    continue
                if query and query.casefold() not in (change.content or "").casefold():
                    continue
                additions.append(change.model_dump())
            tail = additions[staged_offset:]
            more = len(items) + len(tail) > limit
            items.extend(tail[:limit - len(items)])
        accepted, size = [], 64
        for item in items:
            cost = payload_size(item) + 2
            if size + cost > MAX_TOOL_BYTES:
                if not accepted:
                    raise SourceError("maintenance_capacity", "A complete memory entry exceeds the tool budget", 413)
                break
            accepted.append(item)
            size += cost
        visible = {"facts": set(), "profiles": set(), "events": set()}
        visible[collection] = {str(item["id"]) for item in accepted}
        if collection == "events":
            visible["facts"].update(str(fact["id"]) for item in accepted for fact in item.get("evidence", []))
        for kind, reads in self.readset.items():
            self.readset[kind] = {ident: revision for ident, revision in reads.items()
                                 if ident in original_reads[kind] or ident in visible[kind] or revision is None}
        next_cursor = str(offset + len(accepted)) if more or len(accepted) < len(items) else None
        return json.loads(json.dumps({"items": accepted, "next_cursor": next_cursor}, default=str))

    async def read(self, collection, *, ids=None, cursor=None, query=None, limit=100):
        await self.assert_active()
        result = await asyncio.to_thread(self._read, collection, ids, cursor, query, limit)
        await self.assert_active()
        return result

    async def search(self, query, *, limit=20):
        from .event import hybrid_search_user_events
        await self.assert_active()
        result = await hybrid_search_user_events(self.user_id, self.project_id, query, limit=limit,
                                                )
        if not result.ok():
            raise SourceError("maintenance_search_unavailable", "Memory search did not complete", 503,
                              result.code() in {429, 500, 502, 503, 504})
        collections = {}
        for collection in ("facts", "profiles", "events"):
            ranked = getattr(result.data(), collection)
            ids = [str(item.id) for item in ranked]
            # Re-read exact identities to register the same version checks as every
            # other tool. Search never grants support from a different task watermark.
            items = (await self.read(collection, ids=ids, limit=limit))["items"] if ids else []
            by_id = {item["id"]: item for item in items}
            collections[collection] = [dict(by_id[str(item.id)], score=item.score)
                                       for item in ranked if str(item.id) in by_id]
        await self.assert_active()
        return collections

    async def _stage(self, change, kind):
        await self.assert_active()
        collection = "profiles" if kind == "profile" else "events"
        staged = self._staged[collection]
        if change.id is None:
            ident = str(uuid4())
            change = change.model_copy(update={"id": ident})
            self.readset[collection][ident] = None
        else:
            ident = str(_uuid(change.id))
            if ident not in self.readset[collection]:
                raise SourceError("maintenance_target_unread", "Read the target entry before changing it", 502)
            if self.readset[collection][ident] is None and ident not in staged:
                raise SourceError("maintenance_target_absent", "Cannot replace an absent entry with a supplied id", 502)
        if change.action == "upsert":
            if kind == "profile" and change.topic not in self.allowed_topics:
                raise SourceError("maintenance_invalid_topic", "Profile topic is outside the configured topics", 502)
            if kind == "event":
                allowed_tags = {definition["name"] for definition in self.event_tag_definitions}
                if any(tag.tag not in allowed_tags for tag in change.event_tags):
                    raise SourceError("maintenance_invalid_tag", "Event tag is outside the configured tags", 502)
            for fact_id in change.fact_ids:
                if self.readset["facts"].get(str(_uuid(fact_id))) is None:
                    raise SourceError("maintenance_support_unread", "Read valid supporting facts before staging memory", 502)
        staged[ident] = change
        return ident

    async def stage_profile(self, change):
        return await self._stage(change, "profile")

    async def stage_event(self, change):
        return await self._stage(change, "event")

    def _read_changes(self, cursor, limit):
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
                memory_facts.c.support_groups, memory_facts.c.occurred_at, memory_facts.c.event_time,
            ).where(_scope(memory_facts, self.user_id, self.project_id), memory_facts.c.id.in_(ids),
                    memory_facts.c.active.is_(True))).mappings()}
        items, size = [], 64
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
                if ident in self.readset["facts"] and self.readset["facts"][ident] != revision:
                    raise SourceError("maintenance_read_conflict", "Fact changed during the Loop", 409, True)
                self.readset["facts"][ident] = revision
            items.append(item)
            size += cost
        self._seen_changes.update(range(cursor, cursor + len(items)))
        end = cursor + len(items)
        return json.loads(json.dumps({"items": items,
            "next_cursor": str(end) if end < len(self.changes) else None}, default=str))

    async def read_changes(self, *, cursor=None, limit=100):
        await self.assert_active()
        try:
            offset = int(cursor or "0")
        except (ValueError, TypeError):
            raise SourceError("invalid_model_output", "Invalid change cursor", 502) from None
        if offset < 0 or offset > len(self.changes):
            raise SourceError("invalid_model_output", "Invalid change page", 502)
        result = await asyncio.to_thread(self._read_changes, offset, limit)
        await self.assert_active()
        return result

    def get_plan(self, usage):
        from ..maintenance_agent import LoopPlan
        if any(index not in self._seen_changes for index, change in enumerate(self.changes)
               if change.get("kind") != "noop"):
            raise SourceError("maintenance_incomplete", "Not all fixed Fact changes were reviewed", 502, True)
        return LoopPlan(list(self._staged["profiles"].values()), list(self._staged["events"].values()),
                        {key: dict(value) for key, value in self.readset.items()}, usage)


def _verify_readset(session, claim, readset):
    from ..models.database import UserProfile, UserEvent
    from ..models.source import memory_facts
    tables = {"facts": memory_facts, "profiles": UserProfile.__table__, "events": UserEvent.__table__}
    for collection, reads in readset.items():
        table = tables[collection]
        for ident, revision in reads.items():
            statement = select(table.c.revision).where(
                _scope(table, claim.user_id, claim.project_id), table.c.id == _uuid(ident))
            if collection == "facts":
                statement = statement.where(table.c.active.is_(True))
            actual = session.scalar(statement.with_for_update())
            if actual != revision:
                raise SourceError("maintenance_read_conflict", "Related memory changed while the Loop was computed", 409, True)


def _associated_entries(table, collection, user_id, project_id, fact_ids):
    from ..models.source import memory_event_facts
    data = table.c.attributes if collection == "profiles" else table.c.event_data
    matches = [data.contains({"fact_ids": [str(ident)]}) for ident in fact_ids]
    if collection == "events" and fact_ids:
        # FK cascade removes a deleted Fact's relational edge, so the previously
        # saved identity list also locates its now-stale story.
        matches.extend(data.contains({"evidence": [{"fact_id": str(ident)}]}) for ident in fact_ids)
        matches.append(table.c.id.in_(select(memory_event_facts.c.event_id).where(
            _scope(memory_event_facts, user_id, project_id), memory_event_facts.c.fact_id.in_(fact_ids))))
    return or_(*matches) if matches else table.c.id.in_([])


def _verify_resolution(session, claim, plan, kind):
    from ..models.database import UserProfile, UserEvent
    # A no-op is valid for new facts that need no derived entry. Existing entries
    # supported by changed/deleted evidence need an explicit new conclusion.
    changed_ids = [_uuid(change["fact_id"]) for change in claim.changes
                   if change.get("fact_id") and change.get("kind") != "added"]
    if not changed_ids:
        return
    collection = "profiles" if kind == "profile" else "events"
    table = UserProfile.__table__ if kind == "profile" else UserEvent.__table__
    affected = set(map(str, session.scalars(select(table.c.id).where(
        _scope(table, claim.user_id, claim.project_id),
        _associated_entries(table, collection, claim.user_id, claim.project_id, changed_ids)))))
    resolved = {str(_uuid(change.id)) for change in getattr(plan, collection)}
    if affected - resolved:
        raise SourceError("maintenance_unresolved_entries", "Changed evidence still has unreviewed derived entries", 502)


def _apply_plan(session, claim, plan, kind):
    changes = plan.profiles if kind == "profile" else plan.events
    if not changes:
        return
    from ..models.database import UserProfile, UserEvent, UserEventGist
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
        # Stale delayed text can be read, but cannot re-enter historical snapshots.
        invalid = {change["fact_id"] for _, change in pending
                   if change.get("fact_id") and change["kind"] != "added"}
        before = _history_profiles(before, invalid)
        future_invalid = {change["fact_id"] for bid, change in pending
                          if bid != claim.operation_id and change.get("fact_id") and change["kind"] != "added"}
    rules = _project_rules(session, claim.project_id)
    topics = {topic["topic"] for topic in rules["profile_topics"]}
    tags = {definition["name"] for definition in (rules["event_tag_definitions"] or [])}
    for change in changes:
        ident = _uuid(change.id)
        collection = "profiles" if kind == "profile" else "events"
        if str(ident) not in plan.readset[collection]:
            raise SourceError("maintenance_target_unread", "Maintenance target was not registered in the read set", 502)
        if any(plan.readset["facts"].get(str(_uuid(value))) is None for value in change.fact_ids):
            raise SourceError("maintenance_support_unread", "Maintenance support was not read as valid Fact evidence", 502)
        table = UserProfile.__table__ if kind == "profile" else UserEvent.__table__
        existing = session.execute(select(table).where(_scope(table, claim.user_id, claim.project_id),
                                                       table.c.id == ident)).mappings().one_or_none()
        if kind == "event":
            deleted = session.scalar(select(memory_deleted_events.c.id).where(
                _scope(memory_deleted_events, claim.user_id, claim.project_id), memory_deleted_events.c.id == ident))
            if deleted is not None:
                raise SourceError("maintenance_read_conflict", "Event was explicitly deleted", 409, True)
        if change.action == "remove":
            if kind == "event":
                session.execute(delete(UserEventGist).where(UserEventGist.user_id == claim.user_id,
                    UserEventGist.project_id == claim.project_id, UserEventGist.event_id == ident))
            session.execute(delete(table).where(_scope(table, claim.user_id, claim.project_id), table.c.id == ident))
            continue
        # Configuration may have changed while the model was running. Validate
        # against current definitions, not only the Loop's original directory.
        if kind == "profile" and change.topic not in topics:
            raise SourceError("maintenance_read_conflict", "Configured profile topics changed", 409, True)
        if kind == "event" and any(tag.tag not in tags for tag in change.event_tags):
            raise SourceError("maintenance_read_conflict", "Configured event tags changed", 409, True)
        supported = [dict(row) for row in session.execute(select(memory_facts, memory_blobs.c.source_id).join(
            memory_blobs, memory_facts.c.blob_id == memory_blobs.c.id).where(
            _scope(memory_facts, claim.user_id, claim.project_id), memory_facts.c.active.is_(True),
            memory_facts.c.id.in_([_uuid(value) for value in change.fact_ids]))).mappings()]
        if len(supported) != len(change.fact_ids):
            raise SourceError("maintenance_read_conflict", "Supporting facts are no longer valid", 409, True)
        sources = sorted({fact["source_id"] for fact in supported})
        revision = 1 if existing is None else existing["revision"] + 1
        if kind == "profile":
            attributes = {**(existing["attributes"] or {} if existing else {}), "memoia_v2": True,
                          "topic": change.topic, "sub_topic": change.sub_topic,
                          "fact_ids": sorted(change.fact_ids), "source_ids": sources}
            values = {"content": change.content, "attributes": attributes, "revision": revision}
        else:
            blob_ids = sorted({str(fact["blob_id"]) for fact in supported})
            values = {"event_data": {"memoia_v2": True, "event_tip": change.content,
                       **change.model_dump(exclude={"action", "id"}), "source_ids": sources,
                       "blob_ids": blob_ids, "source_id": sources[0] if len(sources) == 1 else None,
                       "blob_id": blob_ids[0] if len(blob_ids) == 1 else None},
                      "embedding": None, "revision": revision}
            session.execute(delete(UserEventGist).where(UserEventGist.user_id == claim.user_id,
                UserEventGist.project_id == claim.project_id, UserEventGist.event_id == ident))
        if existing is None:
            session.execute(table.insert().values(id=ident, user_id=claim.user_id,
                project_id=claim.project_id, **values, created_at=max(fact["occurred_at"] for fact in supported)))
        else:
            session.execute(update(table).where(_scope(table, claim.user_id, claim.project_id),
                table.c.id == ident).values(**values, updated_at=func.now()))
        if kind == "event":
            session.execute(delete(memory_event_facts).where(
                _scope(memory_event_facts, claim.user_id, claim.project_id), memory_event_facts.c.event_id == ident))
            session.execute(memory_event_facts.insert(), [{"event_id": ident, "fact_id": fact["id"],
                "user_id": claim.user_id, "project_id": claim.project_id} for fact in supported])
    if kind == "profile" and changes:
        # A newer deletion can arrive during this Loop. Its stale current text is
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


def _commit_plan(claim, plan, lease, task_lease, model_config):
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
        for kind in ("profile", "event"):
            _apply_plan(session, claim, plan, kind)
        fence_commit(session, claim.user_id, claim.project_id, lease)
        task_lease.check_active()
        complete_flush(session, claim, plan)


async def _finish_sql(function, *args):
    # SQL runs in a thread. Cancellation must await that transaction's outcome
    # before releasing its Redis lease or closing pooled connections.
    execution = asyncio.create_task(asyncio.to_thread(function, *args))
    try:
        return await asyncio.shield(execution)
    except asyncio.CancelledError:
        await execution
        raise


async def execute_claim(claim: Claim, *, runner=None):
    from ..env import LOG
    from ..maintenance_agent import run_loop, LoopUsage
    from .user_lease import UserLease, LeaseUnavailable, LeaseLost
    runner = runner or run_loop
    async with TaskLease(claim) as task_lease:
        try:
            context = await asyncio.to_thread(DBMaintenanceContext, claim, task_lease)
            plan = context.get_plan(LoopUsage()) if all(
                change.get("kind") == "noop" for change in claim.changes) else await runner(context)
            await task_lease.assert_active()
            deadline = time.monotonic() + 30
            while True:
                try:
                    async with UserLease(claim.user_id, claim.project_id) as lease:
                        await _finish_sql(_commit_plan, claim, plan, lease, task_lease,
                                          (context.llm_model, context.reasoning_effort))
                    break
                except LeaseUnavailable:
                    await task_lease.assert_active()
                    if time.monotonic() >= deadline:
                        raise SourceError("lease_unavailable", "Memory writer is still busy", 409, True) from None
                    await asyncio.sleep(.1)
            LOG.info("Flush committed: operation=%s turns=%s input_tokens=%s output_tokens=%s elapsed_seconds=%.3f",
                     claim.operation_id, plan.usage.turns, plan.usage.input_tokens,
                     plan.usage.output_tokens, plan.usage.elapsed_seconds)
        except asyncio.CancelledError:
            await _finish_sql(fail_claim, claim, SourceError("maintenance_cancelled", "Flush was interrupted", 503, True))
            raise
        except Exception as error:
            if isinstance(error, LeaseLost):
                error = SourceError("lease_lost", "Memory write ownership was lost", 409, True)
            await _finish_sql(fail_claim, claim, error)
            return False
    return True
