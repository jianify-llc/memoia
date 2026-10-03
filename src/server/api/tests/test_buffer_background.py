"""后台用户 lease 的并发回归，使用隔离环境中的真实 Redis 执行 Lua。"""

import asyncio
from contextlib import suppress
from datetime import datetime, timezone
from uuid import uuid4

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from redis.asyncio import Redis
from redis.exceptions import ConnectionError
from sqlalchemy import delete, func, select

from api import app
from memoia_server.connectors import Session
from memoia_server.controllers import buffer_background as background
from memoia_server.controllers import blob, buffer, source, user
from memoia_server.controllers.user_lease import CURRENT_LEASE, CHECK_EXPIRE, UserLease, LeaseLost, LeaseUnavailable
from memoia_server.env import BufferStatus
from memoia_server.models.blob import BlobType, BlobData
from memoia_server.models.database import BufferZone, User, UserEvent
from memoia_server.models.response import UserData
from memoia_server.models.source import ImportSource, SourceMessage, memory_sources, memory_operations, user_memory_states
from memoia_server.models.utils import Promise


@pytest_asyncio.fixture
async def user_queue():
    user_id = str(uuid4())
    scope = f"flush_buffer_background_{BlobType.chat}"
    lock_key = background.get_user_lock_key(user_id, "__root__", scope)
    queue_key = background.get_user_buffer_queue_key(user_id, "__root__", scope)
    async with background.get_redis_client() as redis:
        await redis.rpush(queue_key, "batch-a", "batch-b")
        try:
            yield redis, user_id, lock_key, queue_key
        finally:
            await redis.delete(lock_key, queue_key)


async def stop_runner(task):
    if task.done():
        if not task.cancelled():
            task.exception()
        return
    task.cancel()
    with suppress(asyncio.CancelledError):
        await task


@pytest_asyncio.fixture
async def idle_buffer(db_env):
    uid = str(uuid4())
    assert (await user.create_user(UserData(id=uid), "__root__")).ok()
    data = BlobData(blob_type=BlobType.chat, blob_data={"messages": [
        {"role": "user", "content": "My real name is Gus."},
    ]})
    inserted = await blob.insert_blob(uid, "__root__", data)
    assert inserted.ok()
    assert (await buffer.insert_blob_to_buffer(uid, "__root__", inserted.data().id, data.to_blob())).ok()
    with Session() as session:
        bid = session.scalar(select(BufferZone.id).where(BufferZone.user_id == uid,
                                                       BufferZone.project_id == "__root__"))
    try:
        yield uid, bid
    finally:
        async with background.get_redis_client() as redis:
            await redis.delete(background.get_user_lock_key(uid, "__root__", "memory"),
                               background.get_user_buffer_queue_key(uid, "__root__", "flush_buffer_background_chat"))
        with Session.begin() as session:
            session.execute(delete(User).where(User.id == uid, User.project_id == "__root__"))


@pytest.mark.asyncio
async def test_asgi_async_flush_hands_off_to_new_owner_and_commits_once(idle_buffer, bounded_source_model, monkeypatch):
    uid, bid = idle_buffer
    owners, extracted = [], []
    released = asyncio.Event()
    enter, exit = UserLease.__aenter__, UserLease.__aexit__
    extract = bounded_source_model.side_effect
    background_entry = background.flush_buffer_by_ids_in_background

    async def observe_enter(lease):
        owner = await enter(lease)
        owners.append(owner.owner)
        return owner

    async def observe_exit(lease, *args):
        await exit(lease, *args)
        if owners and lease.owner == owners[0]:
            released.set()

    async def after_response_release(*args, **kwargs):
        # ASGI 的 response start 与后台执行可交错；覆盖请求 owner 已释放的合法顺序。
        await asyncio.wait_for(released.wait(), 2)
        await background_entry(*args, **kwargs)

    async def observe_extract(body, **kwargs):
        lease = CURRENT_LEASE.get()
        assert lease is not None and not lease.lost.is_set()
        extracted.append(lease.owner)
        return await extract(body, **kwargs)

    monkeypatch.setattr(UserLease, "__aenter__", observe_enter)
    monkeypatch.setattr(UserLease, "__aexit__", observe_exit)
    monkeypatch.setattr(background, "flush_buffer_by_ids_in_background", after_response_release)
    bounded_source_model.side_effect = observe_extract
    monkeypatch.setenv("ACCESS_TOKEN", "async-flush-local-test-only")
    async with AsyncClient(transport=ASGITransport(app=app, raise_app_exceptions=False),
                           base_url="http://test.local", headers={"Authorization": "Bearer async-flush-local-test-only"}) as client:
        response = await client.post(f"/api/v1/users/buffer/{uid}/chat?wait_process=false")
    assert response.status_code == 200 and response.json()["errno"] == 0
    with Session() as session:
        assert session.scalar(select(BufferZone.status).where(BufferZone.id == bid)) == BufferStatus.done
        assert session.scalar(select(func.count()).select_from(memory_sources).where(memory_sources.c.user_id == uid)) == 1
        assert session.scalar(select(func.count()).select_from(UserEvent).where(UserEvent.user_id == uid)) == 1
    assert extracted and extracted[0] != owners[0]
    async with background.get_redis_client() as redis:
        assert await redis.get(background.get_user_lock_key(uid, "__root__", "memory")) is None


@pytest.mark.asyncio
async def test_background_waits_for_request_owner_without_changing_idle_buffer(idle_buffer, bounded_source_model):
    uid, bid = idle_buffer
    worker = None
    try:
        async with UserLease(uid, "__root__") as request_lease:
            worker = asyncio.create_task(background.flush_buffer_by_ids_in_background(
                uid, "__root__", BlobType.chat, [str(bid)], max_processing_time_s=2,
            ))
            await asyncio.sleep(0.05)
            with Session() as session:
                assert session.scalar(select(BufferZone.status).where(BufferZone.id == bid)) == BufferStatus.idle
            assert bounded_source_model.await_count == 0
            assert CURRENT_LEASE.get() is request_lease
        await asyncio.wait_for(asyncio.shield(worker), 2)
        with Session() as session:
            assert session.scalar(select(BufferZone.status).where(BufferZone.id == bid)) == BufferStatus.done
        assert bounded_source_model.await_count == 1
    finally:
        if worker is not None:
            await stop_runner(worker)


@pytest.mark.asyncio
async def test_background_contention_timeout_preserves_idle_and_other_owner(idle_buffer, bounded_source_model):
    uid, bid = idle_buffer
    async with UserLease(uid, "__root__") as request_lease:
        with pytest.raises(LeaseUnavailable):
            await background.flush_buffer_by_ids_in_background(
                uid, "__root__", BlobType.chat, [str(bid)], max_processing_time_s=0.05,
            )
        assert CURRENT_LEASE.get() is request_lease
        async with background.get_redis_client() as redis:
            assert await redis.get(request_lease.key) == request_lease.owner
            assert await redis.llen(background.get_user_buffer_queue_key(uid, "__root__", "flush_buffer_background_chat")) == 0
        with Session() as session:
            assert session.scalar(select(BufferZone.status).where(BufferZone.id == bid)) == BufferStatus.idle
            assert session.scalar(select(func.count()).select_from(memory_operations).where(memory_operations.c.user_id == uid)) == 0
        assert bounded_source_model.await_count == 0


@pytest.mark.asyncio
async def test_cancel_while_waiting_keeps_request_owner_and_idle(idle_buffer, bounded_source_model):
    uid, bid = idle_buffer
    async with UserLease(uid, "__root__") as request_lease:
        worker = asyncio.create_task(background.flush_buffer_by_ids_in_background(
            uid, "__root__", BlobType.chat, [str(bid)], max_processing_time_s=2,
        ))
        try:
            await asyncio.sleep(0.05)
            await stop_runner(worker)
            async with background.get_redis_client() as redis:
                assert await redis.get(request_lease.key) == request_lease.owner
            with Session() as session:
                assert session.scalar(select(BufferZone.status).where(BufferZone.id == bid)) == BufferStatus.idle
            assert bounded_source_model.await_count == 0
        finally:
            await stop_runner(worker)


@pytest.mark.asyncio
async def test_background_and_v2_share_real_owner_and_register_one_generation(idle_buffer, bounded_source_model, monkeypatch):
    uid, bid = idle_buffer
    entered, release = asyncio.Event(), asyncio.Event()
    original_extract = bounded_source_model.side_effect
    original_init = UserLease.__init__
    owners = []

    def short_real_lease(lease, user_id, project_id, ttl=30):
        original_init(lease, user_id, project_id, ttl=0.3)

    async def blocked_extract(body, **kwargs):
        if not entered.is_set():
            owners.append(CURRENT_LEASE.get())
            entered.set()
            await release.wait()
        return await original_extract(body, **kwargs)

    bounded_source_model.side_effect = blocked_extract
    monkeypatch.setattr(UserLease, "__init__", short_real_lease)
    worker = asyncio.create_task(background.flush_buffer_by_ids_in_background(
        uid, "__root__", BlobType.chat, [str(bid)], max_processing_time_s=2,
    ))
    try:
        await asyncio.wait_for(entered.wait(), 2)
        # 真实核心的模型等待超过两个 TTL，只有 UserLease 自身的一份 heartbeat。
        await asyncio.sleep(0.7)
        assert not owners[0].lost.is_set() and not owners[0]._heartbeat.done()
        async with background.get_redis_client() as redis:
            assert await redis.get(owners[0].key) == owners[0].owner
            assert await redis.pttl(owners[0].key) > 0
        competitor = await source.import_source(uid, "__root__", ImportSource(
            idempotency_key="competing-v2", external_id="competing-v2",
            messages=[SourceMessage(message_id="m-v2", role="user", content="My real name is Gus.",
                                    occurred_at=datetime.now(timezone.utc))],
        ))
        assert competitor.status == "processing"
        assert bounded_source_model.await_count == 1
        with Session() as session:
            assert session.scalar(select(user_memory_states.c.generation).where(user_memory_states.c.user_id == uid)) == 1
        release.set()
        await asyncio.wait_for(asyncio.shield(worker), 2)
        completed = await source.retry_operation(uid, "__root__", competitor.operation_id)
        assert completed.status == "completed"
        with Session() as session:
            assert session.scalar(select(user_memory_states.c.generation).where(user_memory_states.c.user_id == uid)) == 2
            assert session.scalar(select(func.count()).select_from(memory_sources).where(memory_sources.c.user_id == uid)) == 2
        assert bounded_source_model.await_count == 2
    finally:
        release.set()
        await stop_runner(worker)


@pytest.mark.asyncio
async def test_cancel_during_real_flush_releases_lease_without_false_completion(idle_buffer, bounded_source_model):
    uid, bid = idle_buffer
    entered = asyncio.Event()
    owner = []

    async def blocked_extract(*args, **kwargs):
        owner.append(CURRENT_LEASE.get())
        entered.set()
        await asyncio.Event().wait()

    bounded_source_model.side_effect = blocked_extract
    worker = asyncio.create_task(background.flush_buffer_by_ids_in_background(
        uid, "__root__", BlobType.chat, [str(bid)], max_processing_time_s=2,
    ))
    try:
        await asyncio.wait_for(entered.wait(), 2)
        await stop_runner(worker)
        assert owner[0].lost.is_set() and owner[0]._heartbeat.done()
        async with background.get_redis_client() as redis:
            assert await redis.get(owner[0].key) is None
        with Session() as session:
            assert session.scalar(select(BufferZone.status).where(BufferZone.id == bid)) == BufferStatus.processing
            assert session.scalar(select(memory_operations.c.status).where(memory_operations.c.user_id == uid)) == "processing"
            assert session.scalar(select(func.count()).select_from(memory_sources).where(memory_sources.c.user_id == uid)) == 0
            assert session.scalar(select(func.count()).select_from(UserEvent).where(UserEvent.user_id == uid)) == 0
    finally:
        await stop_runner(worker)


@pytest.mark.asyncio
async def test_batch_rejection_is_not_swallowed_as_completed(user_queue, monkeypatch):
    from memoia_server.models.response import CODE
    redis, user_id, lock_key, queue_key = user_queue

    async def reject(*args, **kwargs):
        return Promise.reject(CODE.CONFLICT, "accepted operation is processing")

    monkeypatch.setattr(background, "flush_buffer_by_ids", reject)
    with pytest.raises(RuntimeError, match="uncompleted"):
        await background.flush_buffer_background_running(
            user_id, "__root__", BlobType.chat, max_consecutive_errors=1,
        )
    assert await redis.get(lock_key) is None
    assert await redis.lrange(queue_key, 0, -1) == ["batch-b"]


@pytest.mark.asyncio
async def test_long_flush_renews_lease_without_second_executor(user_queue, monkeypatch):
    redis, user_id, lock_key, queue_key = user_queue
    entered = asyncio.Event()
    release = asyncio.Event()
    active = 0
    max_active = 0
    batches = []

    async def flush(*args, **kwargs):
        nonlocal active, max_active
        active += 1
        max_active = max(max_active, active)
        batches.append(args[3])
        entered.set()
        try:
            await release.wait()
            return Promise.resolve(None)
        finally:
            active -= 1

    monkeypatch.setattr(background, "flush_buffer_by_ids", flush)
    runner = asyncio.create_task(
        background.flush_buffer_background_running(
            user_id, "__root__", BlobType.chat, process_interval_s=1, asleep_waiting_s=0
        )
    )
    competitor = None
    try:
        await asyncio.wait_for(entered.wait(), 2)
        owner = await redis.get(lock_key)
        # 真实墙钟超过两次 lease TTL；原实现此时已失锁，第二个 runner 会抢到 batch-b。
        await asyncio.sleep(2.2)
        competitor = asyncio.create_task(
            background.flush_buffer_background_running(
                user_id, "__root__", BlobType.chat, process_interval_s=1
            )
        )
        await asyncio.wait_for(asyncio.shield(competitor), 0.5)
        assert await redis.get(lock_key) == owner
        assert await redis.pttl(lock_key) > 0
        assert await redis.llen(queue_key) == 1
        assert max_active == 1
        release.set()
        await asyncio.wait_for(asyncio.shield(runner), 2)
        assert batches == [["batch-a"], ["batch-b"]]
        assert max_active == 1
        assert await redis.get(lock_key) is None
    finally:
        release.set()
        await stop_runner(runner)
        if competitor is not None:
            await stop_runner(competitor)


@pytest.mark.asyncio
async def test_lost_owner_neither_renews_nor_deletes_successor_or_takes_batch(
    user_queue, monkeypatch
):
    redis, user_id, lock_key, queue_key = user_queue
    entered = asyncio.Event()
    release = asyncio.Event()
    batches = []

    async def flush(*args, **kwargs):
        batches.append(args[3])
        entered.set()
        await release.wait()
        return Promise.resolve(None)

    monkeypatch.setattr(background, "flush_buffer_by_ids", flush)
    runner = asyncio.create_task(
        background.flush_buffer_background_running(
            user_id, "__root__", BlobType.chat, process_interval_s=1, asleep_waiting_s=0
        )
    )
    try:
        await asyncio.wait_for(entered.wait(), 2)
        await redis.set(lock_key, "successor", px=60000)
        await asyncio.sleep(0.8)
        assert await redis.get(lock_key) == "successor"
        assert await redis.pttl(lock_key) > 50000
        release.set()
        with pytest.raises(LeaseLost):
            await asyncio.wait_for(asyncio.shield(runner), 2)
        assert batches == [["batch-a"]]
        assert await redis.lrange(queue_key, 0, -1) == ["batch-b"]
        assert await redis.get(lock_key) == "successor"
    finally:
        release.set()
        await stop_runner(runner)


@pytest.mark.asyncio
@pytest.mark.parametrize("failure_mode", ["error", "timeout"])
async def test_heartbeat_redis_failure_blocks_later_batches(
    user_queue, monkeypatch, failure_mode
):
    redis, user_id, lock_key, queue_key = user_queue
    entered = asyncio.Event()
    failure = asyncio.Event()
    release = asyncio.Event()
    batches = []
    real_eval = Redis.eval

    async def eval_with_failure(client, script, *args, **kwargs):
        if script == CHECK_EXPIRE:
            if failure_mode == "timeout":
                try:
                    await asyncio.Event().wait()
                finally:
                    failure.set()
            failure.set()
            raise ConnectionError("simulated renewal outage")
        return await real_eval(client, script, *args, **kwargs)

    async def flush(*args, **kwargs):
        batches.append(args[3])
        entered.set()
        await release.wait()
        return Promise.resolve(None)

    monkeypatch.setattr(Redis, "eval", eval_with_failure)
    monkeypatch.setattr(background, "flush_buffer_by_ids", flush)
    runner = asyncio.create_task(
        background.flush_buffer_background_running(
            user_id, "__root__", BlobType.chat, process_interval_s=1, asleep_waiting_s=0
        )
    )
    try:
        await asyncio.wait_for(entered.wait(), 2)
        await asyncio.wait_for(failure.wait(), 2)
        release.set()
        with pytest.raises(LeaseLost):
            await asyncio.wait_for(asyncio.shield(runner), 2)
        assert batches == [["batch-a"]]
        assert await redis.lrange(queue_key, 0, -1) == ["batch-b"]
        assert await redis.get(lock_key) is None
    finally:
        release.set()
        await stop_runner(runner)


@pytest.mark.asyncio
async def test_owner_changed_at_dequeue_boundary_does_not_consume_batch(
    user_queue, monkeypatch
):
    redis, user_id, lock_key, queue_key = user_queue
    real_eval = Redis.eval
    flushes = []

    async def takeover_before_pop(client, script, *args, **kwargs):
        if script == background.REDIS_LUA_CHECK_AND_POP_BATCH:
            await redis.set(lock_key, "successor", px=60000)
        return await real_eval(client, script, *args, **kwargs)

    async def flush(*args, **kwargs):
        flushes.append(args[3])
        return Promise.resolve(None)

    monkeypatch.setattr(Redis, "eval", takeover_before_pop)
    monkeypatch.setattr(background, "flush_buffer_by_ids", flush)
    with pytest.raises(LeaseLost):
        await background.flush_buffer_background_running(user_id, "__root__", BlobType.chat)
    assert flushes == []
    assert await redis.lrange(queue_key, 0, -1) == ["batch-a", "batch-b"]
    assert await redis.get(lock_key) == "successor"


@pytest.mark.asyncio
async def test_cancellation_stops_heartbeat_and_releases_own_lock(user_queue, monkeypatch):
    redis, user_id, lock_key, queue_key = user_queue
    entered = asyncio.Event()
    renewals = []
    real_eval = Redis.eval

    async def observe_eval(client, script, *args, **kwargs):
        if script == CHECK_EXPIRE:
            renewals.append(args)
        return await real_eval(client, script, *args, **kwargs)

    async def flush(*args, **kwargs):
        entered.set()
        await asyncio.Event().wait()

    monkeypatch.setattr(Redis, "eval", observe_eval)
    monkeypatch.setattr(background, "flush_buffer_by_ids", flush)
    runner = asyncio.create_task(
        background.flush_buffer_background_running(
            user_id, "__root__", BlobType.chat, process_interval_s=1
        )
    )
    try:
        await asyncio.wait_for(entered.wait(), 2)
        await asyncio.sleep(0.4)
        await stop_runner(runner)
        assert await redis.get(lock_key) is None
        count = len(renewals)
        assert count > 0
        await asyncio.sleep(0.4)
        assert len(renewals) == count
        assert await redis.lrange(queue_key, 0, -1) == ["batch-b"]
    finally:
        await stop_runner(runner)
