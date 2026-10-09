# Modified for Memoia: relocated from the upstream memobase_server package.
from datetime import datetime, timedelta
from redis.exceptions import RedisError
from ..connectors import get_redis_client, PROJECT_ID
from ..models.database import DEFAULT_PROJECT_ID
from ..env import LOG


def date_key():
    return datetime.now().strftime("%Y-%m-%d")


def month_key():
    return datetime.now().strftime("%Y-%m")


def date_past_key(delay_days: int) -> str:
    return (datetime.now() - timedelta(days=delay_days)).strftime("%Y-%m-%d")


def head_key(project_id: str):
    return f"memobase_telemetry::{PROJECT_ID}::{project_id}"


async def capture_int_key(
    name: str,
    value: int = 1,
    expire_days: int = 14,
    project_id: str = DEFAULT_PROJECT_ID,
):
    return await capture_int_keys({name: value}, expire_days, project_id)


async def capture_int_keys(values: dict[str, int], expire_days: int = 14,
                           project_id: str = DEFAULT_PROJECT_ID) -> bool:
    now = datetime.now()
    prefix = head_key(project_id)
    try:
        async with get_redis_client() as client:
            async with client.pipeline(transaction=True) as pipeline:
                for name, value in values.items():
                    key = f"{prefix}::{name}::{now:%Y-%m-%d}"
                    month = f"{prefix}::{name}::{now:%Y-%m}"
                    pipeline.incrby(key, value)
                    pipeline.incrby(month, value)
                    pipeline.expire(key, expire_days * 86400)
                    pipeline.expire(month, 30 * expire_days * 86400)
                await pipeline.execute()
        return True
    except (RedisError, TimeoutError) as error:
        # These are display counters, not a ledger. Never replay an ambiguous write.
        LOG.warning("Usage statistics write failed (%s)", type(error).__name__)
        return False


async def get_int_keys(keys: list[str]) -> list[int]:
    async with get_redis_client() as client:
        values = await client.mget(keys)
    return [int(value) if value is not None else 0 for value in values]


async def get_int_key(
    name: str,
    project_id: str = DEFAULT_PROJECT_ID,
    in_month: bool = False,
    use_date: str = None,
) -> int:
    if in_month:
        key = f"{head_key(project_id)}::{name}::{month_key()}"
    else:
        using_date = use_date or date_key()
        key = f"{head_key(project_id)}::{name}::{using_date}"
    return (await get_int_keys([key]))[0]


if __name__ == "__main__":
    import asyncio

    print(asyncio.run(capture_int_key("test_key")))
