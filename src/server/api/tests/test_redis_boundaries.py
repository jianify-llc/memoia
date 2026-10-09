"""Redis coordinates writes and approximate counters, never durable memory state."""
import asyncio
from contextlib import asynccontextmanager
from unittest.mock import AsyncMock, MagicMock
from uuid import uuid4

import pytest
from redis.exceptions import ConnectionError, TimeoutError as RedisTimeoutError

from memoia_server import connectors
from memoia_server import llms
from memoia_server.controllers import user_lease, project, billing
from memoia_server.env import Config, TelemetryKeyName
from memoia_server.models.utils import CODE, Promise
from memoia_server.telemetry import capture_key


def test_pool_bounds_override_url_options_and_disable_replay(monkeypatch):
    monkeypatch.setattr(connectors, "REDIS_URL", "redis://localhost/0?max_connections=999&socket_timeout=999")
    monkeypatch.setenv("REDIS_MAX_CONNECTIONS", "3")
    monkeypatch.setenv("REDIS_CONNECT_TIMEOUT_SECONDS", "0.1")
    monkeypatch.setenv("REDIS_SOCKET_TIMEOUT_SECONDS", "0.2")
    pool = connectors.create_redis_pool()
    assert pool.max_connections == 3
    assert pool.connection_kwargs["socket_timeout"] == .2
    assert pool.connection_kwargs["socket_connect_timeout"] == .1
    assert pool.connection_kwargs["retry"]._retries == 0
    monkeypatch.setenv("REDIS_MAX_CONNECTIONS", "0")
    with pytest.raises(ValueError, match="positive"):
        connectors.create_redis_pool()


def test_removed_provider_fails_in_yaml_and_environment(monkeypatch):
    with pytest.raises(ValueError, match="removed"):
        Config(llm_style="doubao_cache")
    monkeypatch.setenv("MEMOBASE_LLM_STYLE", "doubao_cache")
    with pytest.raises(ValueError, match="removed"):
        Config._process_env_vars({})


def fake_client(monkeypatch, *, set_method=None, eval_method=None):
    client = AsyncMock()
    client.set = set_method or AsyncMock(return_value=True)
    client.eval = eval_method or AsyncMock(return_value=1)
    @asynccontextmanager
    async def acquire():
        yield client
    monkeypatch.setattr(user_lease, "get_redis_client", acquire)
    return client


@pytest.mark.asyncio
async def test_acquisition_failure_never_installs_write_authority(monkeypatch):
    fake_client(monkeypatch, set_method=AsyncMock(side_effect=ConnectionError("private")))
    with pytest.raises(user_lease.LeaseUnavailable):
        async with user_lease.UserLease("user", "project"):
            pytest.fail("Redis error must not grant write authority")
    assert user_lease.CURRENT_LEASE.get() is None


@pytest.mark.asyncio
async def test_acquisition_and_release_have_deadlines(monkeypatch):
    async def blocked(*args, **kwargs):
        await asyncio.Event().wait()
    monkeypatch.setattr(user_lease, "LEASE_IO_TIMEOUT_SECONDS", .03)
    fake_client(monkeypatch, set_method=AsyncMock(side_effect=blocked))
    with pytest.raises(user_lease.LeaseUnavailable):
        await asyncio.wait_for(user_lease.UserLease("u", "p").__aenter__(), .5)
    fake_client(monkeypatch, eval_method=AsyncMock(side_effect=blocked))
    async with asyncio.timeout(.5):
        async with user_lease.UserLease("u", "p") as lease:
            pass
    assert lease.lost.is_set() and user_lease.CURRENT_LEASE.get() is None


@pytest.mark.asyncio
@pytest.mark.parametrize("error", [ConnectionError, RedisTimeoutError])
async def test_renewal_failure_invalidates_authority(monkeypatch, error):
    fake_client(monkeypatch, eval_method=AsyncMock(side_effect=error("private")))
    async with user_lease.UserLease("u", "p", ttl=.12) as lease:
        await asyncio.wait_for(lease.lost.wait(), .5)
        with pytest.raises(user_lease.LeaseLost):
            lease.assert_owned()


@pytest.mark.asyncio
async def test_cancellation_joins_heartbeat_and_resets_authority(monkeypatch):
    client = fake_client(monkeypatch)
    entered = asyncio.Event()
    leases = []
    async def run():
        async with user_lease.UserLease("u", "p") as lease:
            leases.append(lease)
            entered.set()
            await asyncio.Event().wait()
    task = asyncio.create_task(run())
    await entered.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert leases[0]._heartbeat.done() and leases[0].lost.is_set()
    assert client.eval.await_args.args[0] == user_lease.CHECK_DELETE
    assert user_lease.CURRENT_LEASE.get() is None


@pytest.mark.asyncio
async def test_statistics_failure_is_not_reported_as_zero(monkeypatch):
    monkeypatch.setattr(project, "get_int_keys", AsyncMock(side_effect=RedisTimeoutError("private")))
    result = await project.get_project_usage("project", 7)
    assert not result.ok() and result.code() == CODE.SERVICE_UNAVAILABLE
    assert "private" not in result.msg()


@pytest.mark.asyncio
async def test_unknown_usage_survives_daily_api_and_has_bounded_retention(db_env, monkeypatch):
    pid = "redis-unknown-" + str(uuid4())
    debit = AsyncMock()
    monkeypatch.setattr(llms, "project_cost_token_billing", debit)
    await llms.record_completion_usage(pid, None, None, 1)
    debit.assert_not_awaited()
    today = (await project.get_project_usage(pid, 1)).data()[0]
    assert not today.usage_complete and today.total_input_token == today.total_output_token == 0
    prefix = capture_key.head_key(pid)
    keys = [f"{prefix}::{TelemetryKeyName.llm_usage_unknown}::{day}" for day in
            (capture_key.date_key(), capture_key.month_key())]
    async with connectors.get_redis_client() as client:
        assert await client.mget(keys) == ["1", "1"]
        assert all([await client.ttl(key) > 0 for key in keys])
        await client.delete(*keys)
    empty = (await project.get_project_usage("redis-empty-" + str(uuid4()), 1)).data()[0]
    assert empty.usage_complete and empty.total_input_token == 0


@pytest.mark.asyncio
async def test_statistics_failure_does_not_skip_existing_billing(monkeypatch):
    monkeypatch.setattr(billing, "capture_int_keys", AsyncMock(return_value=False))
    debit = AsyncMock(return_value=Promise.resolve(None))
    monkeypatch.setattr(billing, "ADMIN_URL", "https://billing.invalid")
    monkeypatch.setattr(billing.admin_api, "cost_project_usage", debit)
    result = await billing.project_cost_token_billing("p", 10, 5)
    assert result.ok()
    debit.assert_awaited_once_with("p", 10, 5)


@pytest.mark.asyncio
async def test_ambiguous_pipeline_write_is_not_replayed(monkeypatch):
    pipeline = MagicMock()
    pipeline.__aenter__ = AsyncMock(return_value=pipeline)
    pipeline.__aexit__ = AsyncMock(return_value=False)
    pipeline.execute = AsyncMock(side_effect=ConnectionError("acknowledgement lost"))
    client = MagicMock()
    client.pipeline.return_value = pipeline
    @asynccontextmanager
    async def acquire():
        yield client
    monkeypatch.setattr(capture_key, "get_redis_client", acquire)
    assert not await capture_key.capture_int_keys({"input": 10, "output": 5}, project_id="p")
    client.pipeline.assert_called_once_with(transaction=True)
    pipeline.execute.assert_awaited_once()
    assert pipeline.incrby.call_count == pipeline.expire.call_count == 4


@pytest.mark.asyncio
async def test_real_statistics_pipeline_counts_and_expires_together(db_env):
    pid = "redis-test-" + str(uuid4())
    names = [TelemetryKeyName.llm_input_tokens, TelemetryKeyName.llm_output_tokens]
    keys = [f"{capture_key.head_key(pid)}::{name}::{date}"
            for name in names for date in (capture_key.date_key(), capture_key.month_key())]
    async with connectors.get_redis_client() as client:
        try:
            assert await capture_key.capture_int_keys(dict(zip(names, [10, 5])), project_id=pid)
            assert await capture_key.get_int_keys(keys) == [10, 10, 5, 5]
            for key in keys:
                assert await client.ttl(key) > 0
        finally:
            await client.delete(*keys)


@pytest.mark.asyncio
async def test_real_owner_replacement_is_never_released(db_env):
    lease = user_lease.UserLease(str(uuid4()), "__root__", ttl=.15)
    async with connectors.get_redis_client() as client:
        try:
            async with lease:
                await client.set(lease.key, "successor", px=1000)
                await asyncio.wait_for(lease.lost.wait(), .5)
                with pytest.raises(user_lease.LeaseLost):
                    lease.assert_owned()
            assert await client.get(lease.key) == "successor"
        finally:
            await client.delete(lease.key)


@pytest.mark.asyncio
async def test_real_noeviction_oom_rejects_counters_without_fabricating_success(db_env):
    pid = "redis-oom-test-" + str(uuid4())
    async with connectors.get_redis_client() as client:
        original = await client.config_get("maxmemory", "maxmemory-policy")
        try:
            await client.config_set("maxmemory-policy", "noeviction")
            await client.config_set("maxmemory", 1)
            assert not await capture_key.capture_int_keys({"input": 10, "output": 5}, project_id=pid)
        finally:
            await client.config_set("maxmemory", original["maxmemory"])
            await client.config_set("maxmemory-policy", original["maxmemory-policy"])
        key = f"{capture_key.head_key(pid)}::input::{capture_key.date_key()}"
        assert await client.get(key) is None
