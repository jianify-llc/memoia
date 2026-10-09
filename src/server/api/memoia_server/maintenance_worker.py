"""Run the same Memoia image as a bounded PostgreSQL maintenance consumer."""

import argparse
import asyncio
import json
import os
from pathlib import Path
import signal
import tempfile
import time

HEARTBEAT_PATH = Path(os.getenv("MAINTENANCE_HEARTBEAT_PATH", "/tmp/memoia-maintenance-worker.json"))
POLL_SECONDS = 2


def record_heartbeat(path=HEARTBEAT_PATH):
    with tempfile.NamedTemporaryFile(mode="w", dir=path.parent, prefix=".memoia-worker-", delete=False) as file:
        json.dump({"pid": os.getpid(), "updated_at": time.time()}, file)
        temporary = file.name
    os.replace(temporary, path)


def healthy(path=HEARTBEAT_PATH):
    try:
        value = json.loads(path.read_text())
        age = time.time() - value["updated_at"]
        if not 0 <= age <= 60:
            return False
        os.kill(int(value["pid"]), 0)
        return True
    except (OSError, ValueError, KeyError, TypeError):
        return False


async def serve(*, concurrency=None, stop=None):
    from .connectors import close_connection, init_redis_client
    from .controllers.maintenance import claim_next, execute_claim, seal_due, reap_expired
    from .env import LOG
    from .schema import check_schema
    concurrency = concurrency if concurrency is not None else int(os.getenv("MAINTENANCE_CONCURRENCY", "2"))
    if not 1 <= concurrency <= 8:
        raise ValueError("MAINTENANCE_CONCURRENCY must be between 1 and 8 per process")
    stop = stop or asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        try:
            loop.add_signal_handler(sig, stop.set)
        except (NotImplementedError, RuntimeError):
            pass
    check_schema()
    init_redis_client()
    active = set()
    try:
        while not stop.is_set():
            finished = {task for task in active if task.done()}
            for task in finished:
                try:
                    task.result()
                except asyncio.CancelledError:
                    pass
                except Exception:
                    LOG.error("Maintenance execution failed; inspect sanitized task status")
            active.difference_update(finished)
            try:
                await asyncio.to_thread(reap_expired)
                await asyncio.to_thread(seal_due)
                while len(active) < concurrency and not stop.is_set():
                    claim = await asyncio.to_thread(claim_next)
                    if claim is None:
                        break
                    active.add(asyncio.create_task(execute_claim(claim)))
                record_heartbeat()
            except Exception:
                LOG.error("Maintenance claim failed; inspect database connectivity")
            try:
                await asyncio.wait_for(stop.wait(), timeout=POLL_SECONDS)
            except TimeoutError:
                pass
    finally:
        # Finite SDK runs are interrupted; execute_claim waits out any in-flight
        # short SQL commit before releasing its leases or closing connections.
        for task in active:
            task.cancel()
        await asyncio.gather(*active, return_exceptions=True)
        await close_connection()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--healthcheck", action="store_true")
    args = parser.parse_args()
    if args.healthcheck:
        raise SystemExit(0 if healthy() else 1)
    asyncio.run(serve())


if __name__ == "__main__":
    main()
