"""Typed HTTP boundary; no database access is required to export OpenAPI."""
from uuid import UUID

from fastapi import APIRouter, Request, Query, HTTPException, Response
from ..models.management import SearchInput
from ..models.source import (
    ImportSource, DeleteMessages, Operation, Operations, Source, Sources, Profiles, Profile, Blob,
    SearchResult, SearchEvent, History, HistoryEntry,
    ForgottenUser,
)

router = APIRouter(prefix="/api", tags=["sources"])


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


@router.post("/users/{user_id}/blobs", response_model=Operation, operation_id="importBlob")
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


@router.get("/users/{user_id}/blobs/{blob_id}", response_model=Blob, operation_id="getBlob")
async def get_blob(user_id: UUID, blob_id: UUID, request: Request):
    from ..controllers import source
    try:
        return source.get_blob(user_id, project_id(request), blob_id)
    except source.SourceError as error:
        translate(error)


@router.get("/users/{user_id}/sources/{source_id}", response_model=Source, operation_id="getSource")
async def get_source(user_id: UUID, source_id: str, request: Request,
                     limit: int = Query(50, ge=1, le=100),
                     message_offset: int = Query(0, ge=0),
                     blob_offset: int = Query(0, ge=0),
                     evidence_offset: int = Query(0, ge=0)):
    from ..controllers import source
    try:
        return source.get_source(user_id, project_id(request), source_id=source_id, limit=limit,
                                 message_offset=message_offset, blob_offset=blob_offset,
                                 evidence_offset=evidence_offset)
    except source.SourceError as error:
        translate(error)


@router.delete("/users/{user_id}/sources/{source_id}/messages", response_model=Operation, operation_id="deleteMessages")
async def delete_messages(user_id: UUID, source_id: str, body: DeleteMessages, request: Request, response: Response):
    from ..controllers import source
    try:
        result = await source.delete_messages(user_id, project_id(request), source_id, body)
    except source.SourceError as error:
        translate(error)
    if result.status == "processing":
        response.status_code = 202
    return result


@router.get("/users/{user_id}/profiles", response_model=Profiles, operation_id="getProfiles", tags=["profiles"])
async def get_profiles(user_id: UUID, request: Request):
    from ..controllers.profile import get_user_profiles
    rows = (await get_user_profiles(str(user_id), project_id(request))).data().profiles
    profiles = [Profile(id=row.id, created_at=row.created_at, content=row.content, topic=(row.attributes or {}).get("topic", ""),
                        sub_topic=(row.attributes or {}).get("sub_topic", ""),
                        source_ids=(row.attributes or {}).get("source_ids", []), updated_at=row.updated_at) for row in rows]
    return Profiles(profiles=sorted(profiles, key=lambda p: (p.topic, p.sub_topic, str(p.id))))


@router.post("/users/{user_id}/search", response_model=SearchResult, operation_id="search", tags=["events"])
async def search(user_id: UUID, body: SearchInput, request: Request):
    from ..controllers.event import hybrid_search_user_events
    result = await hybrid_search_user_events(str(user_id), project_id(request), body.query, body.limit)
    if not result.ok():
        raise HTTPException(503, detail={"code": "search_unavailable", "message": "Search unavailable", "retryable": True})
    return result.data()


@router.get("/users/{user_id}/history", response_model=History, operation_id="getHistory", tags=["profiles"])
async def history(user_id: UUID, request: Request, limit: int = Query(50, ge=1, le=100), offset: int = Query(0, ge=0)):
    from ..controllers import source
    return History(entries=source.get_history(user_id, project_id(request), limit, offset))
