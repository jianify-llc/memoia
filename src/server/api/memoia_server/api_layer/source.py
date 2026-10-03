"""Typed V2 HTTP boundary; no database access is required to export OpenAPI."""
from uuid import UUID

from fastapi import APIRouter, Request, Query, HTTPException, Response
from ..models.source import (
    ImportSource, RetractMessages, Operation, Operations, Source, Sources, Profiles, Profile,
    SearchResult, SearchEvent, History, HistoryEntry,
    ForgottenUser,
)

router = APIRouter(prefix="/api/v2", tags=["sources"])


def project_id(request):
    return request.state.memobase_project_id


def translate(error):
    from ..controllers.source import SourceError
    if not isinstance(error, SourceError):
        raise error
    raise HTTPException(status_code=error.status, detail={
        "code": error.code, "message": error.message, "retryable": error.retryable,
    }) from error


@router.delete("/users/{user_id}", response_model=ForgottenUser, operation_id="forgetUser")
async def forget_user(user_id: UUID, request: Request):
    from ..controllers import source
    try:
        return source.forget_user(user_id, project_id(request))
    except source.SourceError as error:
        translate(error)


@router.post("/users/{user_id}/sources", response_model=Operation, operation_id="importSource")
async def import_source(user_id: UUID, body: ImportSource, request: Request, response: Response):
    from ..controllers import source
    try:
        result = await source.import_source(user_id, project_id(request), body)
    except source.SourceError as error:
        translate(error)
    if result.status == "processing":
        response.status_code = 202
    return result


@router.get("/users/{user_id}/operations/by-key/{idempotency_key}", response_model=Operation, operation_id="getOperationByKey")
async def get_operation_by_key(user_id: UUID, idempotency_key: str, request: Request):
    from ..controllers import source
    try:
        return source.get_operation(user_id, project_id(request), key=idempotency_key)
    except source.SourceError as error:
        translate(error)


@router.get("/users/{user_id}/operations", response_model=Operations, operation_id="listOperations")
async def list_operations(user_id: UUID, request: Request, limit: int = Query(50, ge=1, le=100), offset: int = Query(0, ge=0)):
    from sqlalchemy import select
    from ..connectors import Session
    from ..controllers.source import _operation
    from ..models.source import memory_operations as operations
    with Session() as session:
        rows = session.execute(select(operations).where(operations.c.user_id == user_id,
             operations.c.project_id == project_id(request)).order_by(operations.c.created_at.desc(), operations.c.id)
             .limit(limit).offset(offset)).mappings()
        return Operations(operations=[_operation(row) for row in rows])


@router.get("/users/{user_id}/operations/{operation_id}", response_model=Operation, operation_id="getOperation")
async def get_operation(user_id: UUID, operation_id: UUID, request: Request):
    from ..controllers import source
    try:
        return source.get_operation(user_id, project_id(request), operation_id=operation_id)
    except source.SourceError as error:
        translate(error)


@router.get("/users/{user_id}/sources", response_model=Sources, operation_id="listSources")
async def list_sources(user_id: UUID, request: Request, limit: int = Query(50, ge=1, le=100), offset: int = Query(0, ge=0)):
    from ..controllers import source
    return Sources(sources=source.list_sources(user_id, project_id(request), limit, offset))


@router.post("/users/{user_id}/operations/{operation_id}/retry", response_model=Operation, operation_id="retryOperation")
async def retry_operation(user_id: UUID, operation_id: UUID, request: Request, response: Response):
    from ..controllers import source
    try:
        result = await source.retry_operation(user_id, project_id(request), operation_id)
    except source.SourceError as error:
        translate(error)
    if result.status == "processing":
        response.status_code = 202
    return result


@router.get("/users/{user_id}/sources/by-external-id/{external_id}", response_model=Source, operation_id="getSourceByExternalId")
async def get_source_by_external_id(user_id: UUID, external_id: str, request: Request):
    from ..controllers import source
    try:
        return source.get_source(user_id, project_id(request), external_id=external_id)
    except source.SourceError as error:
        translate(error)


@router.get("/users/{user_id}/sources/{source_id}", response_model=Source, operation_id="getSource")
async def get_source(user_id: UUID, source_id: UUID, request: Request):
    from ..controllers import source
    try:
        return source.get_source(user_id, project_id(request), source_id=source_id)
    except source.SourceError as error:
        translate(error)


@router.post("/users/{user_id}/sources/{source_id}/retract", response_model=Operation, operation_id="retractMessages")
async def retract_messages(user_id: UUID, source_id: UUID, body: RetractMessages, request: Request, response: Response):
    from ..controllers import source
    try:
        result = await source.retract_messages(user_id, project_id(request), source_id, body)
    except source.SourceError as error:
        translate(error)
    if result.status == "processing":
        response.status_code = 202
    return result


@router.get("/users/{user_id}/profiles", response_model=Profiles, operation_id="getProfiles", tags=["profiles"])
async def get_profiles(user_id: UUID, request: Request):
    from ..controllers.profile import get_user_profiles
    rows = (await get_user_profiles(str(user_id), project_id(request))).data().profiles
    profiles = [Profile(id=row.id, content=row.content, topic=(row.attributes or {}).get("topic", ""),
                        sub_topic=(row.attributes or {}).get("sub_topic", ""),
                        source_ids=(row.attributes or {}).get("source_ids", []), updated_at=row.updated_at) for row in rows]
    return Profiles(profiles=sorted(profiles, key=lambda p: (p.topic, p.sub_topic, str(p.id))))


@router.get("/users/{user_id}/search", response_model=SearchResult, operation_id="search", tags=["events"])
async def search(user_id: UUID, request: Request, query: str = Query(min_length=1, max_length=8192), limit: int = Query(10, ge=1, le=100)):
    from ..controllers.event import hybrid_search_user_events
    result = await hybrid_search_user_events(str(user_id), project_id(request), query, limit)
    if not result.ok():
        raise HTTPException(503, detail={"code": "search_unavailable", "message": "Search unavailable", "retryable": True})
    return result.data()


@router.get("/users/{user_id}/history", response_model=History, operation_id="getHistory", tags=["profiles"])
async def history(user_id: UUID, request: Request, limit: int = Query(50, ge=1, le=100), offset: int = Query(0, ge=0)):
    from ..controllers import source
    return History(entries=source.get_history(user_id, project_id(request), limit, offset))
