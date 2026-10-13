"""A cancelled HTTP task must not abandon the SQL transaction holding its lease."""
import asyncio
from contextvars import ContextVar
import threading

import pytest

from memoia_server.connectors import run_sql


def test_database_timeouts_are_positive_and_preserve_url_session_options(monkeypatch):
    from memoia_server import connectors
    monkeypatch.setattr(connectors, "DATABASE_URL", "postgresql://fixture:fixture@localhost/test?options=-csearch_path%3Dfixture,public")
    for key in ("DATABASE_CONNECT_TIMEOUT_SECONDS", "DATABASE_LOCK_TIMEOUT_MS", "DATABASE_STATEMENT_TIMEOUT_MS"):
        monkeypatch.delenv(key, raising=False)
    args = connectors.database_connect_args()
    assert args["connect_timeout"] == 5
    assert args["options"] == "-csearch_path=fixture,public -c lock_timeout=5000 -c statement_timeout=30000"
    assert args["tcp_user_timeout"] == 15000
    monkeypatch.setenv("DATABASE_LOCK_TIMEOUT_MS", "0")
    with pytest.raises(ValueError, match="positive"):
        connectors.database_connect_args()


@pytest.mark.asyncio
@pytest.mark.parametrize("cancel", [False, True])
async def test_database_lock_timeout_rolls_back_before_releasing_lease(db_env, cancel):
    from uuid import uuid4
    from sqlalchemy import create_engine, text
    from sqlalchemy.exc import OperationalError
    from memoia_server import connectors
    from memoia_server.controllers.user_lease import UserLease
    from memoia_server.models.database import User
    uid, key = uuid4(), uuid4().int % (2 ** 63)
    args = connectors.database_connect_args()
    args["options"] += " -c lock_timeout=250 -c statement_timeout=1000"
    engine = create_engine(connectors.DATABASE_URL, connect_args=args)
    started, finished = threading.Event(), threading.Event()
    with connectors.Session.begin() as session:
        session.execute(User.__table__.insert().values(id=uid, project_id="__root__"))
    try:
        with engine.begin() as holder:
            holder.execute(text("SELECT pg_advisory_xact_lock(:key)"), {"key": key})
            async with UserLease(uid, "__root__") as lease:
                def work():
                    try:
                        with engine.begin() as connection:
                            connection.execute(text("UPDATE users SET additional_fields='{}' WHERE id=:uid"), {"uid": uid})
                            started.set()
                            connection.execute(text("SELECT pg_advisory_xact_lock(:key)"), {"key": key})
                    finally:
                        finished.set()
                task = asyncio.create_task(run_sql(work))
                async with asyncio.timeout(3):
                    while not started.is_set():
                        await asyncio.sleep(.001)
                if cancel:
                    task.cancel()
                with pytest.raises(asyncio.CancelledError if cancel else OperationalError) as error:
                    await asyncio.wait_for(task, 3)
                if not cancel:
                    assert error.value.orig.pgcode == "55P03"
                assert finished.is_set()
                lease.assert_owned()
                with engine.connect() as connection:
                    assert connection.execute(text("SELECT additional_fields FROM users WHERE id=:uid"), {"uid": uid}).scalar_one() is None
                    assert connection.execute(text("SELECT 1")).scalar_one() == 1
    finally:
        engine.dispose()
        with connectors.Session.begin() as session:
            session.query(User).filter_by(id=uid, project_id="__root__").delete()


@pytest.mark.asyncio
async def test_database_statement_timeout_keeps_event_loop_responsive(db_env):
    from sqlalchemy import create_engine, text
    from sqlalchemy.exc import OperationalError
    from memoia_server import connectors
    args = connectors.database_connect_args()
    args["options"] += " -c statement_timeout=150"
    engine = create_engine(connectors.DATABASE_URL, connect_args=args)
    def work():
        with engine.begin() as connection:
            connection.execute(text("SELECT pg_sleep(10)"))
    try:
        task = asyncio.create_task(run_sql(work))
        ticks = 0
        while not task.done():
            await asyncio.sleep(.01)
            ticks += 1
        with pytest.raises(OperationalError) as error:
            await task
        assert error.value.orig.pgcode == "57014"
        assert ticks > 2
        with engine.connect() as connection:
            assert connection.execute(text("SELECT 1")).scalar_one() == 1
    finally:
        engine.dispose()


@pytest.mark.asyncio
@pytest.mark.parametrize("fail", [False, True])
async def test_sql_waits_for_outcome_after_repeated_cancellation(fail):
    started, release, finished = threading.Event(), threading.Event(), threading.Event()
    identity = ContextVar("sql-test-identity", default=None)
    identity.set("owned")

    def work():
        assert identity.get() == "owned"
        started.set()
        try:
            assert release.wait(5)
            if fail:
                raise RuntimeError("database failed")
        finally:
            finished.set()

    task = asyncio.create_task(run_sql(work))
    try:
        while not started.is_set():
            await asyncio.sleep(.001)
        task.cancel()
        await asyncio.sleep(.01)
        task.cancel()
        await asyncio.sleep(.01)
        assert not task.done() and not finished.is_set()
    finally:
        release.set()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert finished.is_set()


@pytest.mark.asyncio
async def test_sql_returns_outcome_and_does_not_block_event_loop():
    release = threading.Event()
    task = asyncio.create_task(run_sql(lambda: release.wait(5)))
    await asyncio.sleep(.01)
    assert not task.done()
    release.set()
    assert await task is True
    with pytest.raises(ValueError, match="database"):
        await run_sql(lambda: (_ for _ in ()).throw(ValueError("database")))


@pytest.mark.asyncio
async def test_task_wide_shutdown_still_waits_for_sql():
    started, release, finished = threading.Event(), threading.Event(), threading.Event()

    def work():
        started.set()
        try:
            assert release.wait(5)
        finally:
            finished.set()

    existing = asyncio.all_tasks()
    caller = asyncio.create_task(run_sql(work))
    try:
        while not started.is_set():
            await asyncio.sleep(.001)
        # asyncio.run cancels every Task at shutdown, not only the HTTP caller.
        for task in asyncio.all_tasks() - existing:
            task.cancel()
        await asyncio.sleep(.01)
        assert not caller.done() and not finished.is_set()
    finally:
        release.set()
    with pytest.raises(asyncio.CancelledError):
        await caller
    assert finished.is_set()
