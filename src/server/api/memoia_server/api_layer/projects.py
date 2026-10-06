"""Root creates projects; project administrators manage only their own keys."""
import hashlib
import secrets
from uuid import UUID, uuid4
from datetime import datetime, timezone

from fastapi import APIRouter, Request, HTTPException, Query, Response
from sqlalchemy import select, update, insert, func
from sqlalchemy.exc import IntegrityError

from ..connectors import Session
from ..models.database import Project, Billing, ProjectBilling
from ..models.projects import (
    ProjectCreate, ProjectUpdate, ManagedProject, Projects, KeyCreate, ManagedKey,
    IssuedKey, Keys, LegacyToken, project_api_keys as keys,
)

router = APIRouter(prefix="/api/projects", tags=["projects"])


def authorize(request, project_id=None, *, root=False):
    if request.state.is_memobase_root:
        return
    if root or "admin" not in request.state.memoia_scopes:
        raise HTTPException(403, detail="Project administration requires an administrator")
    if project_id is not None and project_id != request.state.memobase_project_id:
        raise HTTPException(403, detail="Project is outside this key's scope")


def _project(row):
    return ManagedProject(project_id=row.project_id, status=row.status, created_at=row.created_at)


def _key(row):
    return ManagedKey(key_id=row["id"], name=row["name"], scopes=row["scopes"],
                      expires_at=row["expires_at"], revoked_at=row["revoked_at"], created_at=row["created_at"])


@router.get("", response_model=Projects, operation_id="listProjects")
async def list_projects(request: Request, limit: int = Query(50, ge=1, le=100), offset: int = Query(0, ge=0)):
    authorize(request)
    with Session() as session:
        query = session.query(Project)
        if not request.state.is_memobase_root:
            query = query.filter(Project.project_id == request.state.memobase_project_id)
        return Projects(projects=[_project(row) for row in query.order_by(Project.project_id).limit(limit).offset(offset)])


@router.post("", response_model=ManagedProject, operation_id="createProject", status_code=201)
async def create_project(body: ProjectCreate, request: Request):
    authorize(request, root=True)
    try:
        with Session.begin() as session:
            row = session.execute(insert(Project.__table__).values(id=uuid4(), project_id=body.project_id,
                project_secret="sk-" + body.project_id + "-" + secrets.token_hex(32), profile_config=None, status="active")
                .returning(Project.__table__)).one()
            billing = Billing(usage_left=-1)
            session.add(billing)
            session.flush()
            session.add(ProjectBilling(project_id=body.project_id, billing_id=billing.id))
            result = _project(row)
    except IntegrityError as error:
        raise HTTPException(409, detail="Project already exists") from error
    return result


@router.patch("/{project_id}", response_model=ManagedProject, operation_id="updateProject")
async def update_project(project_id: str, body: ProjectUpdate, request: Request):
    authorize(request, root=True)
    if project_id == "__root__":
        raise HTTPException(409, detail="The bootstrap project cannot be suspended")
    with Session.begin() as session:
        count = session.execute(update(Project.__table__).where(Project.project_id == project_id).values(status=body.status)).rowcount
        if not count:
            raise HTTPException(404, detail="Project not found")
        result = _project(session.query(Project).filter_by(project_id=project_id).one())
    return result


@router.get("/{project_id}/keys", response_model=Keys, operation_id="listKeys")
async def list_keys(project_id: str, request: Request,
                    limit: int = Query(50, ge=1, le=100), offset: int = Query(0, ge=0)):
    authorize(request, project_id)
    with Session() as session:
        return Keys(keys=[_key(row) for row in session.execute(select(keys).where(keys.c.project_id == project_id)
                          .order_by(keys.c.created_at, keys.c.id).limit(limit).offset(offset)).mappings()])


@router.post("/{project_id}/keys", response_model=IssuedKey, operation_id="createKey", status_code=201)
async def create_key(project_id: str, body: KeyCreate, request: Request):
    authorize(request, project_id)
    if body.expires_at is not None and body.expires_at <= datetime.now(timezone.utc):
        raise HTTPException(422, detail="expires_at must be in the future")
    key_id = uuid4()
    token = f"mka_{key_id.hex}_{secrets.token_urlsafe(32)}"
    with Session.begin() as session:
        if session.query(Project).filter_by(project_id=project_id).one_or_none() is None:
            raise HTTPException(404, detail="Project not found")
        row = session.execute(insert(keys).values(id=key_id, project_id=project_id, name=body.name,
            token_hash=hashlib.sha256(token.encode()).hexdigest(), scopes=body.scopes, expires_at=body.expires_at)
            .returning(keys)).mappings().one()
        result = IssuedKey(**_key(row).model_dump(), token=token)
    return result


@router.delete("/{project_id}/keys/{key_id}", status_code=204, operation_id="revokeKey")
async def revoke_key(project_id: str, key_id: UUID, request: Request):
    authorize(request, project_id)
    with Session.begin() as session:
        row = session.execute(update(keys).where(keys.c.id == key_id, keys.c.project_id == project_id)
                              .values(revoked_at=func.coalesce(keys.c.revoked_at, func.now())).returning(keys.c.id)).scalar_one_or_none()
        if row is None:
            raise HTTPException(404, detail="Key not found")
    return Response(status_code=204)


@router.post("/{project_id}/legacy-token/rotate", response_model=LegacyToken, operation_id="rotateLegacyToken")
async def rotate_legacy_token(project_id: str, request: Request):
    authorize(request, project_id)
    token = f"sk-{project_id}-{secrets.token_hex(32)}"
    with Session.begin() as session:
        row = session.execute(update(Project.__table__).where(Project.project_id == project_id)
                              .values(project_secret=token).returning(Project.project_id)).scalar_one_or_none()
        if row is None:
            raise HTTPException(404, detail="Project not found")
    return LegacyToken(token=token)
