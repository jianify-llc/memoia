"""Worker liveness and bounded process concurrency, without model/network calls."""

import asyncio
import json
import os
import time
from unittest.mock import AsyncMock

import pytest

from memoia_server import maintenance_worker as worker


def test_worker_health_requires_fresh_heartbeat_and_live_process(tmp_path):
    path = tmp_path / "heartbeat.json"
    assert not worker.healthy(path)
    worker.record_heartbeat(path)
    assert worker.healthy(path)
    record = json.loads(path.read_text())
    assert record["pid"] == os.getpid()
    record["updated_at"] = time.time() - 61
    path.write_text(json.dumps(record))
    assert not worker.healthy(path)


@pytest.mark.parametrize("record", ["not-json", {"pid": "invalid", "updated_at": 0},
                                   {"pid": 999999999, "updated_at": time.time()},
                                   {"pid": os.getpid(), "updated_at": time.time() + 60}])
def test_worker_health_rejects_corrupt_or_invalid_heartbeat(tmp_path, record):
    path = tmp_path / "heartbeat.json"
    path.write_text(record if isinstance(record, str) else json.dumps(record))
    assert not worker.healthy(path)


@pytest.mark.asyncio
async def test_worker_bounds_concurrency_and_closes_runtime(monkeypatch):
    from memoia_server import connectors, schema
    from memoia_server.controllers import maintenance
    stop = asyncio.Event()
    pending = ["a", "b", "c"]
    running = maximum = completed = 0
    async def execute(_claim):
        nonlocal running, maximum, completed
        running += 1
        maximum = max(maximum, running)
        await asyncio.sleep(.02)
        running -= 1
        completed += 1
        if completed == 3:
            stop.set()
    monkeypatch.setattr(maintenance, "seal_due", lambda: None)
    monkeypatch.setattr(maintenance, "reap_expired", lambda: None)
    monkeypatch.setattr(maintenance, "claim_next", lambda: pending.pop(0) if pending else None)
    monkeypatch.setattr(maintenance, "execute_claim", execute)
    monkeypatch.setattr(schema, "check_schema", lambda: None)
    monkeypatch.setattr(connectors, "init_redis_pool", lambda: None)
    close = AsyncMock()
    monkeypatch.setattr(connectors, "close_connection", close)
    monkeypatch.setattr(worker, "record_heartbeat", lambda: None)
    monkeypatch.setattr(worker, "POLL_SECONDS", .005)
    monkeypatch.setattr(asyncio.get_running_loop(), "add_signal_handler", lambda *_: None)
    await asyncio.wait_for(worker.serve(concurrency=2, stop=stop), timeout=2)
    assert maximum == 2 and completed == 3 and running == 0
    close.assert_awaited_once()


@pytest.mark.asyncio
@pytest.mark.parametrize("concurrency", [0, 9])
async def test_worker_rejects_unbounded_concurrency(concurrency):
    with pytest.raises(ValueError, match="between 1 and 8"):
        await worker.serve(concurrency=concurrency)
