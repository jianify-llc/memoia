"""Permanent identity forgetting across real SQL transactions and in-flight models."""
import asyncio
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeout
from contextlib import contextmanager
from datetime import datetime, timezone
import threading
import time
from types import SimpleNamespace
from uuid import uuid4

import httpx
from pydantic import ValidationError
import pytest
from sqlalchemy import create_engine, delete, event, func, select, text
from sqlalchemy.orm import sessionmaker

from api import app
from memoia_server.connectors import DB_ENGINE, Session
from memoia_server.controllers import source, user
from memoia_server.controllers.user_lease import UserLease
from memoia_server.models.database import Project, REG, User, UserProfile
from memoia_server.models.response import UserData
from memoia_server.models.source import ForgottenUser, ImportSource, user_memory_tombstones


@pytest.fixture
def identity(db_env):
    uid = uuid4()
    yield uid
    with Session.begin() as session:
        session.execute(delete(User).where(User.id == uid))
        session.execute(delete(user_memory_tombstones).where(user_memory_tombstones.c.user_id == uid))


def request():
    return ImportSource(idempotency_key="fixed-import", source_id="fixed-source", messages=[{
        "message_id": "1", "role": "user", "content": "My name is Gus",
        "occurred_at": datetime.now(timezone.utc),
    }])


def forgotten_row(uid, project="__root__"):
    with Session() as session:
        return session.execute(select(user_memory_tombstones).where(
            user_memory_tombstones.c.user_id == uid,
            user_memory_tombstones.c.project_id == project,
        )).mappings().one_or_none()


def assert_user_data_absent(uid, project="__root__"):
    with Session() as session:
        assert session.get(User, (uid, project)) is None
        for table in REG.metadata.tables.values():
            if "user_id" not in table.c or "project_id" not in table.c or table is user_memory_tombstones:
                continue
            assert session.scalar(select(func.count()).select_from(table).where(
                table.c.user_id == uid, table.c.project_id == project)) == 0, table.name


def assert_forgotten(error):
    assert error.value.code == "user_forgotten"
    assert error.value.status == 410 and error.value.retryable is False


def test_forget_reply_requires_literal_true():
    with pytest.raises(ValidationError):
        ForgottenUser(user_id=uuid4(), forgotten=False)


def test_identity_lock_key_is_canonical_and_project_scoped():
    uid, keys = uuid4(), []
    executor = SimpleNamespace(execute=lambda statement, parameters: keys.append(parameters["key"]))
    source.lock_user_identity(executor, uid, "project:with/separators")
    source.lock_user_identity(executor, str(uid).upper(), "project:with/separators")
    source.lock_user_identity(executor, uid, "different-project")
    assert keys[0] == keys[1] and keys[0] != keys[2]
    assert all(-(2 ** 63) <= key < 2 ** 63 for key in keys)


@pytest.mark.asyncio
async def test_forget_cascades_and_permanently_blocks_both_protocols(identity, bounded_source_model, monkeypatch):
    uid, body = identity, request()
    operation = await source.import_source(uid, "__root__", body)
    assert operation.status == "completed"
    monkeypatch.setenv("ACCESS_TOKEN", "permanent-delete-test-only")
    client = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test", headers={"Authorization": "Bearer permanent-delete-test-only"})
    try:
        first = (await client.delete(f"/api/users/{uid}"))
        assert first.status_code == 200
        assert first.json() == {"user_id": str(uid), "forgotten": True}
        stamp = forgotten_row(uid)["forgotten_at"]
        assert_user_data_absent(uid)
        assert (await client.delete(f"/api/users/{uid}")).json() == first.json()
        assert forgotten_row(uid)["forgotten_at"] == stamp
        assert (await client.delete(f"/api/users/{uid}")).json()["forgotten"] is True
        assert forgotten_row(uid)["forgotten_at"] == stamp
        legacy = (await client.post("/api/users", json={"id": str(uid)}))
        assert legacy.status_code == 403
        imported = (await client.post(f"/api/users/{uid}/blobs", json=body.model_dump(mode="json")))
        assert imported.status_code == 410
        assert imported.json()["detail"]["code"] == "user_forgotten"
        assert imported.json()["detail"]["retryable"] is False
        recovered = (await client.post(f"/api/users/{uid}/operations/{operation.operation_id}/retry"))
        assert recovered.status_code == 410
        assert (await client.get(f"/api/users/{uid}/sources")).json() == {"sources": []}
        assert (await client.get(f"/api/users/{uid}/profiles")).json() == {"profiles": []}
        assert (await client.get(f"/api/users/{uid}/history")).json() == {"entries": []}
        assert (await client.get(f"/api/users/{uid}/events")).json()["events"] == []
        assert_user_data_absent(uid)
    finally:
        (await client.aclose())


@pytest.mark.asyncio
async def test_v1_delete_still_allows_same_uuid_creation(identity):
    assert (await user.create_user(UserData(id=identity), "__root__")).ok()
    assert (await user.delete_user(identity, "__root__")).ok()
    assert (await user.create_user(UserData(id=identity), "__root__")).ok()
    assert forgotten_row(identity) is None


@pytest.mark.asyncio
async def test_v1_create_materializes_default_uuid_before_identity_guard(db_env):
    created = await user.create_user(UserData(), "__root__")
    assert created.ok() and created.data().id is not None
    uid = created.data().id
    try:
        with Session() as session:
            assert session.get(User, (uid, "__root__")) is not None
        assert forgotten_row(uid) is None
    finally:
        await user.delete_user(uid, "__root__")


@pytest.mark.asyncio
async def test_forget_missing_identity_is_repeatable_but_wrong_token_is_not(identity, monkeypatch):
    monkeypatch.setenv("ACCESS_TOKEN", "permanent-delete-test-only")
    client = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")
    try:
        invalid = (await client.delete(f"/api/users/{identity}", headers={"Authorization": "Bearer invalid"}))
        assert invalid.status_code == 401
        assert forgotten_row(identity) is None
        for _ in range(2):
            response = (await client.delete(f"/api/users/{identity}", headers={"Authorization": "Bearer permanent-delete-test-only"}))
            assert response.status_code == 200
            assert response.json() == {"user_id": str(identity), "forgotten": True}
        assert_user_data_absent(identity)
    finally:
        (await client.aclose())


@pytest.mark.asyncio
async def test_same_uuid_other_project_remains_active(identity, bounded_source_model):
    project = "forget-scope-" + uuid4().hex
    with Session.begin() as session:
        session.execute(Project.__table__.insert().values(id=uuid4(), project_id=project,
            project_secret="synthetic-test-only", profile_config=None, status="active"))
    try:
        await source.import_source(identity, "__root__", request())
        other = await source.import_source(identity, project, request())
        source.forget_user(identity, "__root__")
        assert_user_data_absent(identity)
        assert forgotten_row(identity, project) is None
        assert source.get_operation(identity, project, operation_id=other.operation_id).status == "completed"
        assert len(source.get_source(identity, project, source_id=other.source_id).evidence) == 1
    finally:
        with Session.begin() as session:
            session.execute(delete(User).where(User.id == identity, User.project_id == project))
            session.execute(delete(Project).where(Project.project_id == project))


@pytest.mark.parametrize("first_action", ["register", "forget"])
def test_late_registration_is_serialized_with_forget(identity, monkeypatch, first_action):
    acquired, release, second_started = threading.Event(), threading.Event(), threading.Event()
    original = source.lock_user_identity
    owner = []

    def held_lock(executor, uid, project):
        if threading.current_thread().name != owner[0]:
            second_started.set()
        original(executor, uid, project)
        if threading.current_thread().name == owner[0]:
            acquired.set()
            assert release.wait(5), "First short transaction was not released"

    monkeypatch.setattr(source, "lock_user_identity", held_lock)
    body = request().model_dump(mode="json")
    def register():
        return source._register(identity, "__root__", "fixed-import", "import", body, "fixed-source")
    def forget():
        return source.forget_user(identity, "__root__")
    first, second = (register, forget) if first_action == "register" else (forget, register)
    with ThreadPoolExecutor(max_workers=2, thread_name_prefix="forget-race") as pool:
        owner.append("forget-race_0")
        ahead = pool.submit(first)
        assert acquired.wait(5)
        behind = pool.submit(second)
        try:
            assert second_started.wait(5)
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                with Session() as session:
                    waiting = session.scalar(text("SELECT count(*) FROM pg_locks WHERE locktype='advisory' AND NOT granted"))
                if waiting:
                    break
                time.sleep(.01)
            assert waiting > 0, "Second transaction did not actually wait on the SQL identity lock"
            with pytest.raises(FutureTimeout):
                behind.result(timeout=.01)
        finally:
            release.set()
        ahead.result(timeout=5)
        if first_action == "forget":
            with pytest.raises(source.SourceError) as error:
                behind.result(timeout=5)
            assert_forgotten(error)
        else:
            assert behind.result(timeout=5).forgotten
    assert forgotten_row(identity) is not None
    assert_user_data_absent(identity)


@pytest.mark.asyncio
async def test_forget_preempts_running_model_and_rejects_its_late_commit(identity, bounded_source_model, monkeypatch):
    started, resume = asyncio.Event(), asyncio.Event()
    original = bounded_source_model.side_effect
    async def slow(body, **kwargs):
        started.set()
        await resume.wait()
        return await original(body, **kwargs)
    bounded_source_model.side_effect = slow
    processing = asyncio.create_task(source.import_source(identity, "__root__", request()))
    await asyncio.wait_for(started.wait(), 5)
    try:
        reply = source.forget_user(identity, "__root__")
        assert reply.forgotten
        assert_user_data_absent(identity)
    finally:
        resume.set()
    with pytest.raises(source.SourceError) as error:
        await processing
    assert_forgotten(error)
    assert_user_data_absent(identity)
    assert forgotten_row(identity) is not None


@pytest.mark.asyncio
async def test_forget_after_registration_before_snapshot_never_starts_model(identity, bounded_source_model, monkeypatch):
    original = source._register
    def register_then_forget(*args, **kwargs):
        registered = original(*args, **kwargs)
        source.forget_user(identity, "__root__")
        return registered
    monkeypatch.setattr(source, "_register", register_then_forget)
    with pytest.raises(source.SourceError) as error:
        await source.import_source(identity, "__root__", request())
    assert_forgotten(error)
    bounded_source_model.assert_not_awaited()
    assert_user_data_absent(identity)


@pytest.mark.asyncio
async def test_legacy_late_flush_is_fenced_before_writing_forgotten_user(identity):
    await user.create_user(UserData(id=identity), "__root__")
    async with UserLease(str(identity), "__root__") as lease:
        with Session.begin() as session:
            source._fence_snapshot(session, identity, "__root__", lease)
        source.forget_user(identity, "__root__")
        with pytest.raises(source.SourceError) as error:
            with Session.begin() as session:
                session.add(UserProfile(content="Must not reappear", user_id=identity, project_id="__root__"))
        assert_forgotten(error)
    assert_user_data_absent(identity)


@pytest.mark.asyncio
async def test_cancelled_processing_cannot_resume_after_forgetting(identity, bounded_source_model):
    started = asyncio.Event()
    async def paused(*args, **kwargs):
        started.set()
        await asyncio.Future()
    bounded_source_model.side_effect = paused
    body = request()
    processing = asyncio.create_task(source.import_source(identity, "__root__", body))
    await asyncio.wait_for(started.wait(), 5)
    processing.cancel()
    with pytest.raises(asyncio.CancelledError):
        await processing
    accepted = source.get_operation(identity, "__root__", key=body.idempotency_key)
    assert accepted.status == "processing"
    source.forget_user(identity, "__root__")
    with pytest.raises(source.SourceError) as error:
        await source.retry_operation(identity, "__root__", accepted.operation_id)
    assert_forgotten(error)
    assert_user_data_absent(identity)


@pytest.mark.asyncio
async def test_cancel_before_forget_commit_rolls_back_everything(identity, monkeypatch):
    await user.create_user(UserData(id=identity), "__root__")
    original = source.Session
    @contextmanager
    def cancelled_transaction():
        with original.begin() as session:
            yield session
            raise asyncio.CancelledError()
    with monkeypatch.context() as context:
        context.setattr(source, "Session", SimpleNamespace(begin=cancelled_transaction))
        with pytest.raises(asyncio.CancelledError):
            source.forget_user(identity, "__root__")
    assert forgotten_row(identity) is None
    with Session() as session:
        assert session.get(User, (identity, "__root__")) is not None


def test_lost_commit_ack_can_explicitly_repeat_forgetting(identity):
    def lose_ack(session):
        raise ConnectionError("Synthetic acknowledgement loss after COMMIT")
    event.listen(Session, "after_commit", lose_ack)
    try:
        with pytest.raises(ConnectionError):
            source.forget_user(identity, "__root__")
    finally:
        event.remove(Session, "after_commit", lose_ack)
    stamp = forgotten_row(identity)["forgotten_at"]
    assert source.forget_user(identity, "__root__").forgotten
    assert forgotten_row(identity)["forgotten_at"] == stamp
    assert_user_data_absent(identity)


@pytest.mark.parametrize("commit", [True, False])
def test_transaction_lock_is_released_before_pooled_connection_reuse(identity, commit):
    pooled = create_engine(DB_ENGINE.url, pool_size=1, max_overflow=0)
    owned_session = sessionmaker(bind=pooled)
    try:
        with owned_session() as transaction:
            source.lock_user_identity(transaction, identity, "__root__")
            original_pid = transaction.scalar(text("SELECT pg_backend_pid()"))
            with DB_ENGINE.connect() as observer:
                assert observer.scalar(text("SELECT pg_backend_pid()")) != original_pid
                if commit:
                    transaction.commit()
                else:
                    transaction.rollback()
                assert observer.execute(text("SELECT count(*) FROM pg_locks WHERE locktype='advisory' AND pid=:pid"),
                                        {"pid": original_pid}).scalar_one() == 0
                with owned_session() as reused:
                    assert reused.scalar(text("SELECT pg_backend_pid()")) == original_pid
                    assert observer.execute(text("SELECT count(*) FROM pg_locks WHERE locktype='advisory' AND pid=:pid"),
                                            {"pid": original_pid}).scalar_one() == 0
    finally:
        pooled.dispose()


@pytest.mark.asyncio
async def test_lease_transactions_lock_before_any_sql_but_billing_is_excluded(identity):
    await user.create_user(UserData(id=identity), "__root__")
    async with UserLease(str(identity), "__root__"):
        with Session() as session:
            pid = session.scalar(text("SELECT pg_backend_pid()"))
            assert session.scalar(text("SELECT count(*) FROM pg_locks WHERE pid=:pid AND locktype='advisory' AND granted"),
                                  {"pid": pid}) == 1
        with Session() as billing:
            billing.info["memoia_non_memory_commit"] = True
            pid = billing.scalar(text("SELECT pg_backend_pid()"))
            assert billing.scalar(text("SELECT count(*) FROM pg_locks WHERE pid=:pid AND locktype='advisory'"),
                                  {"pid": pid}) == 0
