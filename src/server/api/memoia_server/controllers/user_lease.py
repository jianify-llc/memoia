"""One renewable owner lease for every mutation of a user's memory."""
import asyncio
from contextlib import suppress
from contextvars import ContextVar
from uuid import uuid4

from ..connectors import get_redis_client, PROJECT_ID


CHECK_EXPIRE = """
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('pexpire', KEYS[1], ARGV[2])
end
return 0
"""
CHECK_DELETE = """
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
end
return 0
"""
CURRENT_LEASE: ContextVar["UserLease | None"] = ContextVar("memoia_user_lease", default=None)


class LeaseUnavailable(Exception):
    pass


class LeaseLost(Exception):
    pass


class UserLease:
    def __init__(self, user_id: str, project_id: str, ttl: float = 30):
        self.identity = (str(user_id), project_id)
        self.key = f"memobase:user_lock:{PROJECT_ID}:memory:{project_id}:{user_id}"
        self.owner = str(uuid4())
        self.ttl_ms = max(100, int(ttl * 1000))
        self.lost = asyncio.Event()
        self.generation = None
        self.version = None
        self._heartbeat = None
        self._nested = False

    async def __aenter__(self):
        current = CURRENT_LEASE.get()
        if current is not None and current.identity == self.identity:
            current.assert_owned()
            self._nested = True
            return current
        async with get_redis_client() as client:
            if not await client.set(self.key, self.owner, nx=True, px=self.ttl_ms):
                raise LeaseUnavailable()
        self._token = CURRENT_LEASE.set(self)
        self._heartbeat = asyncio.create_task(self._renew())
        return self

    def assert_owned(self):
        if self.lost.is_set():
            raise LeaseLost()

    async def _renew(self):
        interval = self.ttl_ms / 3000
        try:
            while True:
                await asyncio.sleep(interval)
                async with asyncio.timeout(interval):
                    async with get_redis_client() as client:
                        result = await client.eval(CHECK_EXPIRE, 1, self.key, self.owner, self.ttl_ms)
                if result != 1:
                    self.lost.set()
                    return
        except Exception:
            # A Redis error is not proof of ownership; the SQL fence remains authoritative.
            self.lost.set()

    async def __aexit__(self, *_):
        if self._nested:
            return
        self._heartbeat.cancel()
        with suppress(asyncio.CancelledError):
            await self._heartbeat
        CURRENT_LEASE.reset(self._token)
        try:
            async with get_redis_client() as client:
                await client.eval(CHECK_DELETE, 1, self.key, self.owner)
        except Exception:
            self.lost.set()
        finally:
            # Detached tasks inherit ContextVars, not the right to keep using a released lease.
            self.lost.set()
