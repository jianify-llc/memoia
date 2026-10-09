"""Redis coordinates writes and approximate counters, never durable memory state."""
import asyncio
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


@pytest.mark.asyncio
async def test_shared_client_lifecycle_and_explicit_initialization(monkeypatch):
    client = connectors.get_redis_client()
    assert connectors.get_redis_client() is client
    with pytest.raises(RuntimeError, match="already initialized"):
        connectors.init_redis_client()
    close_pool = AsyncMock(wraps=client.connection_pool.disconnect)
    monkeypatch.setattr(client.connection_pool, "disconnect", close_pool)
    monkeypatch.setattr(client, "ping", AsyncMock(return_value=True))
    assert await connectors.redis_health_check()
    assert connectors.get_redis_client() is client
    close_pool.assert_not_awaited()
    await connectors.close_connection()
    close_pool.assert_awaited_once()
    with pytest.raises(RuntimeError, match="not initialized"):
        connectors.get_redis_client()
    await connectors.close_connection()
    close_pool.assert_awaited_once()
    connectors.init_redis_client()
    assert connectors.get_redis_client() is not client


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", [RuntimeError("startup failed"), asyncio.CancelledError()])
async def test_api_startup_failure_or_cancellation_closes_shared_client(monkeypatch, failure):
    import api
    from memoia_server import schema
    await connectors.close_connection()
    monkeypatch.setattr(schema, "check_schema", lambda: None)
    monkeypatch.setattr(api, "check_embedding_sanity", AsyncMock(side_effect=failure))
    model = AsyncMock()
    monkeypatch.setattr(api, "llm_sanity_check", model)
    pool = connectors.create_redis_pool()
    close_pool = AsyncMock(wraps=pool.disconnect)
    monkeypatch.setattr(pool, "disconnect", close_pool)
    monkeypatch.setattr(connectors, "create_redis_pool", lambda: pool)
    with pytest.raises(type(failure)):
        async with api.lifespan(api.app):
            pytest.fail("Failed startup must not accept requests")
    assert connectors.REDIS_CLIENT is None
    close_pool.assert_awaited_once()
    model.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", [None, RuntimeError("sweep failed during shutdown")])
async def test_api_shutdown_waits_for_sweep_and_closes_even_if_it_fails(monkeypatch, failure):
    import api
    from memoia_server import schema
    from memoia_server.controllers import source

    await connectors.close_connection()
    monkeypatch.setattr(schema, "check_schema", lambda: None)
    monkeypatch.setattr(api, "check_embedding_sanity", AsyncMock())
    monkeypatch.setattr(api, "llm_sanity_check", AsyncMock())
    close = AsyncMock(wraps=connectors.close_connection)
    monkeypatch.setattr(api, "close_connection", close)
    entered, cancelled, release = asyncio.Event(), asyncio.Event(), asyncio.Event()
    shield = asyncio.shield

    async def observe_cancellation(task):
        try:
            return await shield(task)
        except asyncio.CancelledError:
            cancelled.set()
            raise

    monkeypatch.setattr(asyncio, "shield", observe_cancellation)

    async def finish_sweep(callback):
        assert callback is source.purge_expired_inputs
        entered.set()
        await release.wait()
        if failure is not None:
            raise failure

    sweep = AsyncMock(side_effect=finish_sweep)
    monkeypatch.setattr(asyncio, "to_thread", sweep)
    runtime = api.lifespan(api.app)
    await runtime.__aenter__()
    await asyncio.wait_for(entered.wait(), .5)
    client = connectors.get_redis_client()
    disconnect = AsyncMock(wraps=client.connection_pool.disconnect)
    monkeypatch.setattr(client.connection_pool, "disconnect", disconnect)
    stopping = asyncio.create_task(runtime.__aexit__(None, None, None))
    try:
        await asyncio.wait_for(cancelled.wait(), .5)
        assert not stopping.done()
        close.assert_not_awaited()
        disconnect.assert_not_awaited()
        release.set()
        # A timeout must not send a second cancellation that masks the shutdown bug.
        done, _ = await asyncio.wait({stopping}, timeout=.5)
        assert stopping in done
        await stopping
        sweep.assert_awaited_once()
        close.assert_awaited_once()
        disconnect.assert_awaited_once()
        assert connectors.REDIS_CLIENT is None
    finally:
        release.set()
        if not stopping.done():
            stopping.cancel()
        await asyncio.gather(stopping, return_exceptions=True)


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
    monkeypatch.setattr(user_lease, "get_redis_client", lambda: client)
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
    client = connectors.get_redis_client()
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
    monkeypatch.setattr(capture_key, "get_redis_client", lambda: client)
    assert not await capture_key.capture_int_keys({"input": 10, "output": 5}, project_id="p")
    client.pipeline.assert_called_once_with(transaction=False)
    pipeline.execute.assert_awaited_once()
    assert pipeline.incrby.call_count == pipeline.expire.call_count == 4
    client.aclose.assert_not_called()


@pytest.mark.asyncio
async def test_partial_statistics_pipeline_failure_does_not_replay_successful_counter(monkeypatch):
    from redis.exceptions import ResponseError
    client = MagicMock()
    pipeline = MagicMock()
    pipeline.__aenter__ = AsyncMock(return_value=pipeline)
    pipeline.__aexit__ = AsyncMock(return_value=False)
    # A non-transactional batch can apply some commands before returning an error.
    pipeline.execute = AsyncMock(side_effect=ResponseError("counter is not an integer"))
    client.pipeline.return_value = pipeline
    monkeypatch.setattr(capture_key, "get_redis_client", lambda: client)
    assert not await capture_key.capture_int_keys({"input": 10, "output": 5})
    pipeline.execute.assert_awaited_once()
    client.pipeline.assert_called_once_with(transaction=False)
    client.aclose.assert_not_called()


@pytest.mark.asyncio
async def test_real_statistics_pipeline_counts_and_sets_retention(db_env):
    pid = "redis-test-" + str(uuid4())
    names = [TelemetryKeyName.llm_input_tokens, TelemetryKeyName.llm_output_tokens]
    keys = [f"{capture_key.head_key(pid)}::{name}::{date}"
            for name in names for date in (capture_key.date_key(), capture_key.month_key())]
    client = connectors.get_redis_client()
    try:
        assert await capture_key.capture_int_keys(dict(zip(names, [10, 5])), project_id=pid)
        assert connectors.get_redis_client() is client
        assert await connectors.redis_health_check()
        assert await capture_key.get_int_keys(keys) == [10, 10, 5, 5]
        for key in keys:
            assert await client.ttl(key) > 0
    finally:
        await client.delete(*keys)


@pytest.mark.asyncio
async def test_real_owner_replacement_is_never_released(db_env):
    lease = user_lease.UserLease(str(uuid4()), "__root__", ttl=.15)
    client = connectors.get_redis_client()
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
    client = connectors.get_redis_client()
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
