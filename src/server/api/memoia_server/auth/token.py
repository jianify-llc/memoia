# Modified for Memoia: relocated from the upstream memobase_server package.
from hashlib import sha256
from datetime import datetime
from random import random
from typing import Tuple
from uuid import uuid4
from ..models.utils import Promise
from ..models.response import CODE
from ..connectors import get_redis_client
from ..controllers import project


def parse_project_id(secret_key: str) -> Promise[str]:
    if not secret_key.startswith("sk-"):
        return Promise.reject(CODE.UNAUTHORIZED, "Invalid secret key")
    parts = secret_key[3:].split("-")
    if len(parts) < 2:
        return Promise.reject(CODE.UNAUTHORIZED, "Invalid secret key")
    project_id = "-".join(parts[:-1]).strip()
    return Promise.resolve(project_id)


def token_redis_key(project_id: str) -> str:
    return f"memobase::auth::token::{project_id}"


def project_status_redis_key(project_id: str) -> str:
    return f"memobase::auth::project_status::{project_id}"


async def check_project_secret(project_id: str, secret_key: str) -> Promise[bool]:
    from hmac import compare_digest
    p = await project.get_project_secret(project_id)
    if not p.ok():
        return Promise.reject(CODE.UNAUTHORIZED, "Project unavailable")
    return Promise.resolve(compare_digest(p.data(), secret_key))


async def get_project_status(project_id: str) -> Promise[str]:
    # Revocation and suspension must affect the very next request.
    return await project.get_project_status(project_id)


def authenticate_scoped_key(token: str):
    from hmac import compare_digest
    from uuid import UUID
    from sqlalchemy import select, or_, func
    from ..connectors import Session
    from ..models.database import Project
    from ..models.project_v2 import project_api_keys as keys
    try:
        prefix, key_id, secret = token.split("_", 2)
        if prefix != "mka" or not secret:
            return None
        parsed_id = UUID(key_id)
    except (ValueError, AttributeError):
        return None
    with Session() as session:
        row = session.execute(select(keys, Project.status.label("project_status"))
            .join(Project, Project.project_id == keys.c.project_id)
            .where(keys.c.id == parsed_id, keys.c.revoked_at.is_(None),
                   or_(keys.c.expires_at.is_(None), keys.c.expires_at > func.now()))).mappings().one_or_none()
        if row is None or row["project_status"] == "suspended":
            return None
        if not compare_digest(row["token_hash"], sha256(token.encode()).hexdigest()):
            return None
        return row["project_id"], row["scopes"]
