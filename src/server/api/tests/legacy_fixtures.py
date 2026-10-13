"""Database fixture helpers for historical input cleanup; not production APIs."""
from memoia_server.connectors import Session, run_sql
from memoia_server.models.database import User, GeneralBlob
from memoia_server.models.blob import BlobType
from memoia_server.models.response import CODE, IdsData
from memoia_server.models.utils import Promise


async def delete_user(user_id: str, project_id: str) -> Promise[None]:
    def execute():
        with Session() as session:
            db_user = (
                session.query(User)
                .filter_by(id=user_id, project_id=project_id)
                .one_or_none()
            )
            if db_user is None:
                return Promise.resolve(None)
            session.delete(db_user)
            session.commit()
        return Promise.resolve(None)
    return await run_sql(execute)


async def get_user_all_blobs(
    user_id: str,
    project_id: str,
    blob_type: BlobType,
    page: int = 0,
    page_size: int = 10,
) -> Promise[IdsData]:
    def execute():
        with Session() as session:
            user_blobs = (
                session.query(GeneralBlob.id)
                .filter_by(user_id=user_id, blob_type=str(blob_type), project_id=project_id)
                .order_by(GeneralBlob.created_at)
                .offset(page * page_size)
                .limit(page_size)
                .all()
            )
            if user_blobs is None:
                return Promise.reject(CODE.NOT_FOUND, f"User {user_id} not found")
            return Promise.resolve(IdsData(ids=[blob.id for blob in user_blobs]))
    return await run_sql(execute)
