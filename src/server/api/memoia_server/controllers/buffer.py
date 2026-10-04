# Modified for Memoia: relocated from the upstream memobase_server package.
from sqlalchemy import func
from pydantic import BaseModel
from ..env import CONFIG, BufferStatus, TRACE_LOG
from ..utils import (
    get_blob_token_size,
    pack_blob_from_db,
)
from ..models.utils import Promise
from ..models.response import CODE, ChatModalResponse, IdsData
from ..models.database import BufferZone, GeneralBlob
from ..models.blob import BlobType, Blob
from ..connectors import Session, log_pool_status
from .modal import BLOBS_PROCESS


async def get_buffer_capacity(
    user_id: str, project_id: str, blob_type: BlobType
) -> Promise[int]:
    with Session() as session:
        buffer_count = (
            session.query(BufferZone.id)
            .filter_by(
                user_id=user_id,
                blob_type=str(blob_type),
                project_id=project_id,
                status=BufferStatus.idle,
            )
            .count()
        )
    return Promise.resolve(buffer_count)


async def insert_blob_to_buffer(
    user_id: str, project_id: str, blob_id: str, blob_data: Blob
) -> Promise[None]:
    with Session() as session:
        buffer = BufferZone(
            user_id=user_id,
            blob_id=blob_id,
            blob_type=blob_data.type,
            token_size=get_blob_token_size(blob_data),
            project_id=project_id,
            status=BufferStatus.idle,
        )
        session.add(buffer)
        session.commit()
    return Promise.resolve(None)


async def wait_insert_done_then_flush(
    user_id: str, project_id: str, blob_type: BlobType
) -> Promise[ChatModalResponse | None]:
    p = await get_unprocessed_buffer_ids(user_id, project_id, blob_type)
    if not p.ok():
        return p
    if p.data() is None:
        return Promise.resolve([])
    p = await flush_buffer_by_ids(user_id, project_id, blob_type, p.data().ids)
    if not p.ok():
        return p
    if p.data() is not None:
        return Promise.resolve(p.data())
    return Promise.resolve(None)


async def detect_buffer_full_or_not(
    user_id: str, project_id: str, blob_type: BlobType
) -> Promise[IdsData | None]:
    with Session() as session:
        # 1. if buffer size reach maximum, flush it
        buffer_zone = (
            session.query(BufferZone.id, BufferZone.token_size)
            .filter_by(
                user_id=user_id,
                blob_type=str(blob_type),
                project_id=project_id,
                status=BufferStatus.idle,
            )
            .all()
        )
        buffer_ids = [row.id for row in buffer_zone]
        buffer_token_size = sum(row.token_size for row in buffer_zone)
        if (
            buffer_token_size
            and buffer_token_size > CONFIG.max_chat_blob_buffer_token_size
        ):
            TRACE_LOG.info(
                project_id,
                user_id,
                f"Flush {blob_type} buffer due to reach maximum token size({buffer_token_size} > {CONFIG.max_chat_blob_buffer_token_size})",
            )

            return Promise.resolve(IdsData(ids=buffer_ids))
    return Promise.resolve(IdsData(ids=[]))


async def get_unprocessed_buffer_ids(
    user_id: str,
    project_id: str,
    blob_type: BlobType,
    select_status: str = BufferStatus.idle,
) -> Promise[IdsData]:
    with Session() as session:
        buffer_ids = (
            session.query(BufferZone.id)
            .filter_by(
                user_id=user_id,
                blob_type=str(blob_type),
                project_id=project_id,
                status=select_status,
            )
            .all()
        )
        return Promise.resolve(IdsData(ids=[row.id for row in buffer_ids]))


async def flush_buffer_by_ids(
    user_id: str,
    project_id: str,
    blob_type: BlobType,
    buffer_ids: list[str],
    select_status: str = BufferStatus.idle,
) -> Promise[ChatModalResponse | None]:
    # FIXME: parallel calling will cause duplicated flush
    if blob_type not in BLOBS_PROCESS:
        return Promise.reject(CODE.BAD_REQUEST, f"Blob type {blob_type} not supported")
    if not len(buffer_ids):
        return Promise.resolve(None)

    # Log initial pool status
    log_pool_status(f"flush_buffer_by_ids_start_{blob_type}")

    with Session() as session:
        # Join BufferZone with GeneralBlob to get all data in one query
        buffer_blob_data = (
            session.query(
                BufferZone.id.label("buffer_id"),
                BufferZone.blob_id,
                BufferZone.token_size,
                BufferZone.created_at.label("buffer_created_at"),
                GeneralBlob.created_at,
                GeneralBlob.blob_data,
            )
            .join(GeneralBlob, BufferZone.blob_id == GeneralBlob.id)
            .filter(
                BufferZone.user_id == user_id,
                BufferZone.blob_type == str(blob_type),
                BufferZone.project_id == project_id,
                GeneralBlob.user_id == user_id,
                GeneralBlob.project_id == project_id,
                BufferZone.status == select_status,
                BufferZone.id.in_(buffer_ids),
            )
            .order_by(BufferZone.created_at)
            .all()
        )
        # Update buffer status to processing
        process_buffer_ids = [row.buffer_id for row in buffer_blob_data]
        if select_status != BufferStatus.processing:
            session.query(BufferZone).filter(
                BufferZone.id.in_(process_buffer_ids),
            ).update(
                {BufferZone.status: BufferStatus.processing},
                synchronize_session=False,
            )

        if not buffer_blob_data:
            TRACE_LOG.info(
                project_id,
                user_id,
                f"No {blob_type} buffer to flush",
            )
            return Promise.resolve(None)

        blob_ids = [row.blob_id for row in buffer_blob_data]
        blobs = [pack_blob_from_db(row, blob_type) for row in buffer_blob_data]
        total_token_size = sum(row.token_size for row in buffer_blob_data)
        TRACE_LOG.info(
            project_id,
            user_id,
            f"Flush {blob_type} buffer with {len(buffer_blob_data)} blobs and total token size({total_token_size})",
        )

        session.commit()

    try:
        # Pack blobs from the joined data

        # Process blobs first (moved outside the session)
        # The accepted blob IDs give this flush a stable internal identity, not a body hash.
        # A second insertion of identical text has new blob IDs and remains a new operation.
        from uuid import uuid5, NAMESPACE_URL
        from datetime import datetime, timezone
        from ..models.source import ImportSource, SourceMessage
        from .source import import_source, get_operation, retry_operation, SourceError
        identity = str(uuid5(NAMESPACE_URL, f"{project_id}:{user_id}:" + ":".join(str(i) for i in blob_ids)))
        messages = []
        for row, blob in zip(buffer_blob_data, blobs, strict=True):
            entries = blob.messages if blob_type == BlobType.chat else [
                type("SummaryMessage", (), {"role": "user", "content": blob.summary, "created_at": None})()
            ]
            for index, message in enumerate(entries):
                occurred_at = row.created_at
                if message.created_at:
                    occurred_at = datetime.fromisoformat(message.created_at)
                    if occurred_at.tzinfo is None:
                        occurred_at = occurred_at.replace(tzinfo=timezone.utc)
                messages.append(SourceMessage(message_id=f"{row.blob_id}:{index}", role=message.role,
                                              content=message.content, occurred_at=occurred_at))
        try:
            body = ImportSource(
                idempotency_key=f"v1-flush:{identity}", source_id=f"v1-flush:{identity}", messages=messages,
            )
            try:
                accepted = get_operation(user_id, project_id, key=body.idempotency_key)
            except SourceError as error:
                if error.code != "operation_not_found":
                    raise
                accepted = None
            # Pre-0006 receipts keep their explicit legacy grouping. Never relabel
            # an accepted request or present generated IDs as external message IDs.
            result = await retry_operation(user_id, project_id, accepted.operation_id) if accepted else await import_source(
                user_id, project_id, body, legacy_buffers=(process_buffer_ids, blob_ids))
        except SourceError as error:
            p = Promise.reject(CODE(error.status) if error.status in CODE else CODE.BAD_REQUEST, error.message)
        else:
            if result.status != "completed":
                return Promise.reject(CODE.CONFLICT, "Flush is processing; query/recover the accepted operation")
            p = Promise.resolve(ChatModalResponse(event_id=result.result.event_ids[0] if result.result.event_ids else None,
                                                 add_profiles=result.result.profile_ids, update_profiles=[], delete_profiles=[]))
        if not p.ok():
            # Rollback buffer status to failed if the process failed
            with Session() as session:
                session.query(BufferZone).filter(
                    BufferZone.id.in_(process_buffer_ids),
                ).update(
                    {BufferZone.status: BufferStatus.failed},
                    synchronize_session=False,
                )
                session.commit()
            return p
        with Session() as session:
            try:
                # Update buffer status to done
                session.query(BufferZone).filter(
                    BufferZone.id.in_(process_buffer_ids),
                ).update(
                    {BufferZone.status: BufferStatus.done},
                    synchronize_session=False,
                )
                if blob_type == BlobType.chat:
                    session.query(GeneralBlob).filter(
                        GeneralBlob.id.in_(blob_ids),
                        GeneralBlob.project_id == project_id,
                    ).delete(synchronize_session=False)
                session.commit()
                TRACE_LOG.info(
                    project_id,
                    user_id,
                    f"Flushed {blob_type} buffer(size: {len(buffer_blob_data)})",
                )
            except Exception as e:
                session.rollback()
                TRACE_LOG.error(
                    project_id,
                    user_id,
                    f"DB Error while deleting buffers/blobs: {e}",
                )
                log_pool_status(f"flush_buffer_by_ids_db_error_{blob_type}")
                raise e

        return p

    except Exception as e:
        with Session() as session:
            session.query(BufferZone).filter(
                BufferZone.id.in_(process_buffer_ids),
            ).update(
                {BufferZone.status: BufferStatus.failed},
                synchronize_session=False,
            )
            session.commit()
        TRACE_LOG.error(
            project_id,
            user_id,
            f"Error in flush_buffer: {e}. Buffer status updated to failed.",
        )
        log_pool_status(f"flush_buffer_by_ids_exception_{blob_type}")
        raise e


async def flush_buffer(
    user_id: str, project_id: str, blob_type: BlobType
) -> Promise[ChatModalResponse | None]:
    p = await get_unprocessed_buffer_ids(user_id, project_id, blob_type)
    if not p.ok():
        return p
    p = await flush_buffer_by_ids(user_id, project_id, blob_type, p.data().ids)
    return p
