"""后台用户 lease 的并发回归，使用隔离环境中的真实 Redis 执行 Lua。"""

import asyncio
from contextlib import suppress
from uuid import uuid4

import pytest
import pytest_asyncio
from redis.asyncio import Redis
from redis.exceptions import ConnectionError

from memoia_server.controllers import buffer_background as background
from memoia_server.models.blob import BlobType
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
    task.cancel()
    with suppress(asyncio.CancelledError):
        await task


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
        if script == background.REDIS_LUA_CHECK_AND_EXPIRE_LOCK:
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
        if script == background.REDIS_LUA_CHECK_AND_EXPIRE_LOCK:
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
