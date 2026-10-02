# Modified for Memoia: relocated package and renewable background user leases.
import uuid
import asyncio
import traceback
from contextlib import suppress
from sqlalchemy import func
from pydantic import BaseModel
from ..env import CONFIG, BufferStatus, TRACE_LOG
from ..models.utils import Promise
from ..models.response import CODE, ChatModalResponse, IdsData, UUID
from ..models.database import BufferZone, GeneralBlob
from ..models.blob import BlobType, Blob
from ..connectors import Session, PROJECT_ID, get_redis_client
from .modal import BLOBS_PROCESS
from .buffer import flush_buffer_by_ids

REDIS_LUA_CHECK_AND_DELETE_LOCK = """
if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("del", KEYS[1])
else
    return 0
end
"""

REDIS_LUA_CHECK_AND_EXPIRE_LOCK = """
if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("pexpire", KEYS[1], ARGV[2])
else
    return 0
end
"""

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


async def flush_buffer_by_ids_in_background(
    user_id: str, project_id: str, blob_type: BlobType, buffer_ids: list[str]
) -> None:
    if not len(buffer_ids):
        return
    if blob_type not in BLOBS_PROCESS:
        return

    # 1. mark buffer as processing
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

    try:
        async with get_redis_client() as redis_client:
            await redis_client.rpush(buffer_queue_key, buffer_ids_str)

            queue_size = await redis_client.llen(buffer_queue_key)

            TRACE_LOG.info(
                project_id,
                user_id,
                f"[background] Enqueued {len(actual_buffer_ids)} buffer IDs to queue (queue size: {queue_size})",
            )

        await flush_buffer_background_running(user_id, project_id, blob_type)
    except Exception as e:
        TRACE_LOG.error(
            project_id,
            user_id,
            f"[background] Error enqueue buffer ids: {e}: {traceback.format_exc()}",
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
    user_key = get_user_lock_key(
        user_id, project_id, f"flush_buffer_background_{blob_type}"
    )
    buffer_queue_key = get_user_buffer_queue_key(
        user_id, project_id, f"flush_buffer_background_{blob_type}"
    )

    __lock_value = str(uuid.uuid4())
    start_time = asyncio.get_event_loop().time()
    if process_interval_s <= 0:
        raise ValueError("User lease TTL must be positive")
    lease_ttl_ms = max(1, int(process_interval_s * 1000))
    renew_interval_s = lease_ttl_ms / 3000
    lease_lost = asyncio.Event()

    async with get_redis_client() as redis_client:
        acquired = await redis_client.set(
            user_key, __lock_value, nx=True, px=lease_ttl_ms
        )
        if not acquired:
            TRACE_LOG.debug(
                project_id,
                user_id,
                f"[background] Lock already acquired",
            )
            return

    async def heartbeat():
        # 独立于整个 batch 的模型等待；失锁或无法确认续租时保守停止后续取任务。
        try:
            while True:
                await asyncio.sleep(renew_interval_s)
                async with asyncio.timeout(renew_interval_s):
                    async with get_redis_client() as redis_client:
                        renewed = await redis_client.eval(
                            REDIS_LUA_CHECK_AND_EXPIRE_LOCK,
                            1,
                            user_key,
                            __lock_value,
                            lease_ttl_ms,
                        )
                if renewed != 1:
                    lease_lost.set()
                    TRACE_LOG.warning(project_id, user_id, "[background] User lease lost")
                    return
        except Exception as e:
            lease_lost.set()
            TRACE_LOG.error(
                project_id, user_id, f"[background] Cannot confirm user lease renewal: {e}"
            )

    heartbeat_task = asyncio.create_task(heartbeat())
    from .user_lease import UserLease, CURRENT_LEASE
    lease = UserLease(user_id, project_id)
    lease.owner = __lock_value
    lease.lost = lease_lost
    context_token = CURRENT_LEASE.set(lease)
    try:
        iteration_count = 0
        consecutive_errors = 0

        while iteration_count < max_iterations:
            if lease_lost.is_set():
                break
            current_time = asyncio.get_event_loop().time()

            # Check if we've exceeded maximum processing time
            if current_time - start_time > max_processing_time_s:
                TRACE_LOG.warning(
                    project_id,
                    user_id,
                    f"[background] Maximum processing time ({max_processing_time_s}s) exceeded",
                )
                break

            # 原子校验 owner 并弹出任务，禁止失锁后的旧执行者消费新 owner 的队列。
            async with get_redis_client() as redis_client:
                batch = await redis_client.eval(
                    REDIS_LUA_CHECK_AND_POP_BATCH,
                    2,
                    user_key,
                    buffer_queue_key,
                    __lock_value,
                )
                if batch[0] != 1:
                    lease_lost.set()
                    TRACE_LOG.debug(
                        project_id,
                        user_id,
                        "[background] Lock expired",
                    )
                    break

                buffer_ids_str = batch[1]
                if buffer_ids_str is None:  # Queue is empty
                    TRACE_LOG.debug(
                        project_id,
                        user_id,
                        "[background] Queue empty",
                    )
                    break

                current_queue_size = await redis_client.llen(buffer_queue_key)

            TRACE_LOG.info(
                project_id,
                user_id,
                f"[background]({iteration_count}/{max_iterations}) Processing buffer (left queue size: {current_queue_size})",
            )

            buffer_ids = unpack_ids_from_str(buffer_ids_str or "")
            if not buffer_ids:
                continue

            try:
                # 不强行取消在途处理：取消等待不代表外部模型已停止，不能盲目重放。
                processing_start = asyncio.get_event_loop().time()

                p = await flush_buffer_by_ids(
                    user_id,
                    project_id,
                    blob_type,
                    buffer_ids,
                    select_status=BufferStatus.processing,
                )

                processing_time = asyncio.get_event_loop().time() - processing_start

                if not p.ok():
                    consecutive_errors += 1
                    TRACE_LOG.error(
                        project_id,
                        user_id,
                        f"[background] Error flushing buffer by ids: {p.msg()}",
                    )

                    # Stop if too many consecutive errors
                    if consecutive_errors >= max_consecutive_errors:
                        TRACE_LOG.error(
                            project_id,
                            user_id,
                            f"[background] Too many consecutive errors ({consecutive_errors}), stopping",
                        )
                        break
                else:
                    consecutive_errors = 0  # Reset error counter on success
                    TRACE_LOG.debug(
                        project_id,
                        user_id,
                        f"[background] Processed batch in {processing_time:.2f}s",
                    )

            except Exception as e:
                consecutive_errors += 1
                TRACE_LOG.error(
                    project_id,
                    user_id,
                    f"[background] Unknown Error flushing buffer by ids: {e}\n{traceback.format_exc()}",
                )

                # Stop if too many consecutive errors
                if consecutive_errors >= max_consecutive_errors:
                    TRACE_LOG.error(
                        project_id,
                        user_id,
                        f"[background] Too many consecutive errors ({consecutive_errors}), stopping",
                    )
                    break

            # Sleep between iterations to prevent overwhelming the system
            await asyncio.sleep(asleep_waiting_s)
            iteration_count += 1

        total_processing_time = asyncio.get_event_loop().time() - start_time
        TRACE_LOG.info(
            project_id,
            user_id,
            f"[background] Completed processing. "
            f"Iterations: {iteration_count}, Time: {total_processing_time:.2f}s, "
            f"Final consecutive errors: {consecutive_errors}",
        )

    finally:
        # 释放前先停止并收回 heartbeat；异常、取消和正常退出共用此清理路径。
        heartbeat_task.cancel()
        with suppress(asyncio.CancelledError):
            await heartbeat_task
        CURRENT_LEASE.reset(context_token)
        lease_lost.set()
        try:
            async with get_redis_client() as redis_client:
                result = await redis_client.eval(
                    REDIS_LUA_CHECK_AND_DELETE_LOCK, 1, user_key, __lock_value
                )
                if result == 1:
                    TRACE_LOG.debug(
                        project_id,
                        user_id,
                        f"[background] Successfully released lock",
                    )
                else:
                    TRACE_LOG.warning(
                        project_id,
                        user_id,
                        f"[background] Lock was already expired/released",
                    )
        except Exception as e:
            TRACE_LOG.error(
                project_id,
                user_id,
                f"[background] Failed to release lock: {e}",
            )
