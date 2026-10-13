# Modified for Memoia: relocated from the upstream memobase_server package.
from ..models.utils import Promise
from ..models.database import User
from ..models.response import CODE, UserData, IdData
from ..connectors import Session, run_sql


async def create_user(data: UserData, project_id: str) -> Promise[IdData]:
    def execute():
        from .source import assert_user_active, SourceError
        with Session() as session:
            db_user = User(additional_fields=data.data, project_id=project_id)
            if data.id is not None:
                db_user.id = str(data.id)
            try:
                assert_user_active(session, db_user.id, project_id)
            except SourceError:
                return Promise.reject(CODE.FORBIDDEN, "User identity was permanently forgotten")
            session.add(db_user)
            session.commit()
            return Promise.resolve(IdData(id=db_user.id))
    return await run_sql(execute)


async def get_user(user_id: str, project_id: str) -> Promise[UserData]:
    def execute():
        with Session() as session:
            db_user = (
                session.query(User)
                .filter_by(id=user_id, project_id=project_id)
                .one_or_none()
            )
            if db_user is None:
                return Promise.reject(CODE.NOT_FOUND, f"User {user_id} not found")
            return Promise.resolve(
                UserData(
                    data=db_user.additional_fields,
                    created_at=db_user.created_at,
                    updated_at=db_user.updated_at,
                )
            )
    return await run_sql(execute)
