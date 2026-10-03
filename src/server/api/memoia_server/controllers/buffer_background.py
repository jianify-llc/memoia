# Modified for Memoia: relocated package and renewable background user leases.
import asyncio
from contextlib import asynccontextmanager
from ..env import BufferStatus, TRACE_LOG
from ..models.database import BufferZone
from ..models.blob import BlobType
from ..connectors import Session, PROJECT_ID, get_redis_client
from .modal import BLOBS_PROCESS
from .buffer import flush_buffer_by_ids
from .user_lease import CURRENT_LEASE, UserLease, LeaseUnavailable, LeaseLost

REDIS_LUA_CHECK_AND_POP_BATCH = """
if redis.call("get", KEYS[1]) ~= ARGV[1] then
    return {0}
end
return {1, redis.call("lpop", KEYS[2])}
"""


def get_user_lock_key(user_id: str, project_id: str, scope: str) -> str:
    return f"memobase:user_lock:{PROJECT_ID}:memory:{project_id}:{user_id}"


def get_user_buffer_queue_key(user_id: str, project_id: str, scope: str) -> str:
    return f"memobase:user_buffer_queue:{PROJECT_ID}:{scope}:{project_id}:{user_id}"


def pack_ids_to_str(ids: list[str]) -> str:
    return "::".join([str(i) for i in ids])


def unpack_ids_from_str(ids_str: str) -> list[str]:
    return [i.strip() for i in ids_str.split("::") if i.strip()]


@asynccontextmanager
async def _background_user_lease(user_id: str, project_id: str, deadline: float):
    # BackgroundTasks 复制请求 ContextVar，但请求 owner 不属于后台执行者。
    context_token = CURRENT_LEASE.set(None)
    try:
        while True:
            if asyncio.get_running_loop().time() >= deadline:
                raise LeaseUnavailable()
            lease = UserLease(str(user_id), project_id)
            try:
                await lease.__aenter__()
                break
            except LeaseUnavailable:
                remaining = deadline - asyncio.get_running_loop().time()
                if remaining <= 0:
                    raise
                await asyncio.sleep(min(0.1, remaining))
        try:
            yield lease
        finally:
            await lease.__aexit__(None, None, None)
    finally:
        CURRENT_LEASE.reset(context_token)


async def flush_buffer_by_ids_in_background(
    user_id: str, project_id: str, blob_type: BlobType, buffer_ids: list[str],
    *, max_processing_time_s: float = 60 * 15,
) -> None:
    if not len(buffer_ids):
        return
    if blob_type not in BLOBS_PROCESS:
        return
    if max_processing_time_s <= 0:
        raise ValueError("Background processing budget must be positive")

    deadline = asyncio.get_running_loop().time() + max_processing_time_s
    try:
        async with _background_user_lease(user_id, project_id, deadline):
            await _enqueue_and_flush(user_id, project_id, blob_type, buffer_ids, deadline)
    except Exception as error:
        TRACE_LOG.error(project_id, user_id,
                        f"[background] Flush stopped ({type(error).__name__}); not completed")
        raise


async def _enqueue_and_flush(user_id, project_id, blob_type, buffer_ids, deadline):
    # 取得独立 owner 后才改状态；等待超时或取消不会把 idle 标成 processing。
    with Session() as session:
        buffer_blob_data = (
            session.query(BufferZone.id)
            .filter(
                BufferZone.user_id == user_id,
                BufferZone.blob_type == str(blob_type),
                BufferZone.project_id == project_id,
                BufferZone.status == BufferStatus.idle,
                BufferZone.id.in_(buffer_ids),
            )
            .order_by(BufferZone.created_at)
            .all()
        )
        actual_buffer_ids = [row.id for row in buffer_blob_data]
        if not len(actual_buffer_ids):
            return
        session.query(BufferZone).filter(
            BufferZone.id.in_(actual_buffer_ids),
        ).update(
            {BufferZone.status: BufferStatus.processing},
            synchronize_session=False,
        )

        session.commit()

    # 2. add actual buffer ids to a redis queue
    buffer_queue_key = get_user_buffer_queue_key(
        user_id, project_id, f"flush_buffer_background_{blob_type}"
    )
    buffer_ids_str = pack_ids_to_str(actual_buffer_ids)

    async with get_redis_client() as redis_client:
        await redis_client.rpush(buffer_queue_key, buffer_ids_str)

        queue_size = await redis_client.llen(buffer_queue_key)

        TRACE_LOG.info(
            project_id,
            user_id,
            f"[background] Enqueued {len(actual_buffer_ids)} buffer IDs to queue (queue size: {queue_size})",
        )

    # 核心 import_source 在计算前登记 generation；这里不另建执行代次。
    await flush_buffer_background_running(
        user_id, project_id, blob_type,
        max_processing_time_s=max(0, deadline - asyncio.get_running_loop().time()),
    )


async def flush_buffer_background_running(
    user_id: str,
    project_id: str,
    blob_type: BlobType,
    asleep_waiting_s: float = 0.1,  # Increased from 0.001 to reduce CPU usage
    max_iterations: int = 200,  # Maximum 200 tasks for this run, return after it reaches.
    process_interval_s: float = 60 * 5,  # Lease TTL, renewed throughout processing
    max_processing_time_s: float = 60 * 15,  # Maximum 15 minutes total processing time
    max_consecutive_errors=5,  # Stop after 5 consecutive errors
):
    if process_interval_s <= 0:
        raise ValueError("User lease TTL must be positive")
    try:
        # 后台入口复用真实 owner；直调 runner 也经过同一个 UserLease 原语。
        async with UserLease(str(user_id), project_id, ttl=process_interval_s) as lease:
            await _flush_queued_batches(user_id, project_id, blob_type, lease,
                                        asleep_waiting_s, max_iterations,
                                        max_processing_time_s, max_consecutive_errors)
    except LeaseUnavailable:
        TRACE_LOG.debug(project_id, user_id, "[background] Another user owner is active")


async def _flush_queued_batches(user_id, project_id, blob_type, lease,
                                asleep_waiting_s, max_iterations,
                                max_processing_time_s, max_consecutive_errors):
    buffer_queue_key = get_user_buffer_queue_key(
        user_id, project_id, f"flush_buffer_background_{blob_type}"
    )
    start_time = asyncio.get_running_loop().time()
    encountered_error = False
    consecutive_errors = 0
    for iteration in range(max_iterations):
        lease.assert_owned()
        if asyncio.get_running_loop().time() - start_time > max_processing_time_s:
            raise TimeoutError("Background flush processing budget exhausted")

        # 原子校验 owner 并弹出任务，禁止失锁后的旧执行者消费新 owner 的队列。
        async with get_redis_client() as redis_client:
            batch = await redis_client.eval(
                REDIS_LUA_CHECK_AND_POP_BATCH, 2, lease.key, buffer_queue_key, lease.owner,
            )
            if batch[0] != 1:
                lease.lost.set()
                raise LeaseLost()
            if batch[1] is None:
                break
            current_queue_size = await redis_client.llen(buffer_queue_key)

        TRACE_LOG.info(project_id, user_id,
                       f"[background]({iteration}/{max_iterations}) Processing buffer (left queue size: {current_queue_size})")
        buffer_ids = unpack_ids_from_str(batch[1])
        if not buffer_ids:
            continue
        try:
            # 不强行取消在途模型等待：取消不证明供应商停止，不能据此重放。
            result = await flush_buffer_by_ids(
                user_id, project_id, blob_type, buffer_ids,
                select_status=BufferStatus.processing,
            )
        except LeaseLost:
            raise
        except Exception as error:
            encountered_error = True
            consecutive_errors += 1
            TRACE_LOG.error(project_id, user_id,
                            f"[background] Batch failed ({type(error).__name__}); not completed")
        else:
            if result.ok():
                consecutive_errors = 0
            else:
                encountered_error = True
                consecutive_errors += 1
                TRACE_LOG.error(project_id, user_id,
                                "[background] Buffer core rejected this batch; not completed")
        if consecutive_errors >= max_consecutive_errors:
            break
        await asyncio.sleep(asleep_waiting_s)

    lease.assert_owned()
    if encountered_error:
        raise RuntimeError("Background flush contains uncompleted batches")
    TRACE_LOG.info(project_id, user_id,
                   f"[background] Finished draining this run in {asyncio.get_running_loop().time() - start_time:.2f}s")
