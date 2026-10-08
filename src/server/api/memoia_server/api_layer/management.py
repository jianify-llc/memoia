"""Single HTTP management boundary; existing controllers remain the data writers."""
from contextlib import asynccontextmanager
from typing import Literal
from uuid import UUID, uuid4
from fastapi import APIRouter, Request, Query, HTTPException, Response
from sqlalchemy.exc import IntegrityError
from ..models.management import ContextInput, Context, ProfileInput, ProfileConfig, Usage, Health, Users, ProjectUser, Events
from ..models.response import UserData, IdData, EventGistData
from ..connectors import Session
from ..models.database import User

router = APIRouter(prefix="/api")


def unwrap(result):
    if not result.ok():
        status = int(result.code())
        raise HTTPException(status if 400 <= status <= 599 else 500,
            detail={"code": "operation_rejected", "message": "Operation rejected", "retryable": status >= 500})
    return result.data()


@asynccontextmanager
async def user_write(user_id, project_id, *, creating=False):
    # 手工管理与来源写入使用同一 lease 和 SQL fence，不能并发提交过期结果。
    from ..controllers.user_lease import UserLease, LeaseLost, LeaseUnavailable
    from ..controllers.source import _fence_snapshot, SourceError
    try:
        async with UserLease(str(user_id), project_id) as lease:
            with Session.begin() as session:
                if session.get(User, (user_id, project_id)) is None:
                    if not creating:
                        raise HTTPException(404, detail={"code": "user_not_found", "message": "User not found", "retryable": False})
                else:
                    _fence_snapshot(session, str(user_id), project_id, lease)
            yield
    except (LeaseLost, LeaseUnavailable):
        raise HTTPException(409, detail={"code": "lease_lost", "message": "User memory is being modified", "retryable": True})
    except SourceError as error:
        from .source import translate
        translate(error)


@router.get("/healthcheck", response_model=Health, operation_id="healthcheck")
async def healthcheck():
    from ..connectors import db_health_check, redis_health_check
    if not db_health_check() or not await redis_health_check():
        raise HTTPException(503, detail={"code": "health_unavailable", "message": "Service unavailable", "retryable": True})
    return Health()


@router.post("/users", response_model=IdData, status_code=201, operation_id="createUser")
async def create_user(body: UserData, request: Request):
    from ..controllers.user import create_user as create
    uid = body.id or uuid4()
    try:
        async with user_write(uid, request.state.memobase_project_id, creating=True):
            return unwrap(await create(UserData(id=uid, data=body.data), request.state.memobase_project_id))
    except IntegrityError:
        raise HTTPException(409, detail={"code": "user_exists", "message": "User already exists", "retryable": False})


@router.get("/users", response_model=Users, operation_id="listUsers")
async def list_users(request: Request, search: str = Query("", max_length=256),
    order_by: Literal["updated_at", "profile_count", "event_count"] = "updated_at",
    order_desc: bool = True, limit: int = Query(10, ge=1, le=100), offset: int = Query(0, ge=0)):
    from ..controllers.project import get_project_users
    result = unwrap(await get_project_users(request.state.memobase_project_id, search, limit, offset, order_by, order_desc))
    fields = ProjectUser.model_fields
    return Users(users=[ProjectUser(**{key: value for key, value in row.items() if key in fields}) for row in result.users], count=result.count)


@router.get("/users/{user_id}", response_model=UserData, operation_id="getUser")
async def get_user(user_id: UUID, request: Request):
    from ..controllers.user import get_user as read
    return unwrap(await read(str(user_id), request.state.memobase_project_id))


@router.post("/users/{user_id}/profiles", response_model=IdData, operation_id="addProfile", status_code=201)
async def add_profile(user_id: UUID, body: ProfileInput, request: Request):
    from ..controllers.profile import add_user_profiles
    async with user_write(user_id, request.state.memobase_project_id):
        result = unwrap(await add_user_profiles(str(user_id), request.state.memobase_project_id,
            [body.content], [{"topic": body.topic, "sub_topic": body.sub_topic}]))
        return IdData(id=result.ids[0])


@router.patch("/users/{user_id}/profiles/{profile_id}", status_code=204, operation_id="updateProfile")
async def update_profile(user_id: UUID, profile_id: UUID, body: ProfileInput, request: Request):
    from ..controllers.profile import update_user_profiles
    async with user_write(user_id, request.state.memobase_project_id):
        result = unwrap(await update_user_profiles(str(user_id), request.state.memobase_project_id,
            [str(profile_id)], [body.content], [{"topic": body.topic, "sub_topic": body.sub_topic}]))
        if not result.ids:
            raise HTTPException(404, detail={"code": "profile_not_found", "message": "Profile not found", "retryable": False})
    return Response(status_code=204)


@router.delete("/users/{user_id}/profiles/{profile_id}", status_code=204, operation_id="deleteProfile")
async def delete_profile(user_id: UUID, profile_id: UUID, request: Request):
    from ..controllers.profile import delete_user_profile
    async with user_write(user_id, request.state.memobase_project_id):
        unwrap(await delete_user_profile(str(user_id), request.state.memobase_project_id, str(profile_id)))
    return Response(status_code=204)


@router.get("/users/{user_id}/events", response_model=Events, operation_id="getEvents")
async def get_events(user_id: UUID, request: Request, limit: int = Query(10, ge=1, le=100),
    time_range_in_days: int = Query(360, ge=1, le=36500)):
    from ..controllers.event import get_user_events
    return unwrap(await get_user_events(str(user_id), request.state.memobase_project_id,
        topk=limit, time_range_in_days=time_range_in_days))


@router.delete("/users/{user_id}/events/{event_id}", status_code=204, operation_id="deleteEvent")
async def delete_event(user_id: UUID, event_id: UUID, request: Request):
    from ..controllers.event import delete_user_event
    async with user_write(user_id, request.state.memobase_project_id):
        unwrap(await delete_user_event(str(user_id), request.state.memobase_project_id, str(event_id)))
    return Response(status_code=204)


@router.post("/users/{user_id}/context", response_model=Context, operation_id="getContext")
async def context(user_id: UUID, body: ContextInput, request: Request):
    from ..controllers.event import retrieve_user_facts, recent_user_facts
    from ..temporal import render_gist
    from ..utils import get_encoded_tokens
    if body.query is not None:
        result = unwrap(await retrieve_user_facts(str(user_id), request.state.memobase_project_id, body.query))
        entries = [render_gist(fact.gist) for fact in result]
    else:
        entries = [render_gist(fact) for fact in recent_user_facts(str(user_id), request.state.memobase_project_id)]
    # 事实与其证据共同计预算；大批次不能让全部短事实都被丢弃。
    kept = []
    for entry in entries:
        candidate = "\n\n".join([*kept, entry])
        if len(get_encoded_tokens(candidate)) > body.max_token_size:
            continue
        if entry:
            kept.append(entry)
    return Context(context="\n\n".join(kept), entries=kept)


@router.get("/project/config", response_model=ProfileConfig, operation_id="getConfig")
async def get_config(request: Request):
    from ..controllers.project import get_project_profile_config_string
    return unwrap(await get_project_profile_config_string(request.state.memobase_project_id))


@router.patch("/project/config", status_code=204, operation_id="updateConfig")
async def update_config(body: ProfileConfig, request: Request):
    from ..controllers.project import update_project_profile_config
    from ..utils import is_valid_profile_config
    unwrap(is_valid_profile_config(body.profile_config))
    unwrap(await update_project_profile_config(request.state.memobase_project_id, body.profile_config))
    return Response(status_code=204)


@router.get("/project/usage", response_model=Usage, operation_id="getUsage")
async def get_usage(request: Request, last_days: int = Query(7, ge=1, le=365)):
    from ..controllers.project import get_project_usage
    return Usage(usages=unwrap(await get_project_usage(request.state.memobase_project_id, last_days)))
