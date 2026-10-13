# Modified for Memoia: relocated from the upstream memobase_server package.
from hashlib import sha256
from ..models.utils import Promise
from ..models.response import CODE


def parse_project_id(secret_key: str) -> Promise[str]:
    if not secret_key.startswith("sk-"):
        return Promise.reject(CODE.UNAUTHORIZED, "Invalid secret key")
    parts = secret_key[3:].split("-")
    if len(parts) < 2:
        return Promise.reject(CODE.UNAUTHORIZED, "Invalid secret key")
    project_id = "-".join(parts[:-1]).strip()
    return Promise.resolve(project_id)


def authenticate_legacy_token(secret_key: str) -> Promise[str]:
    from hmac import compare_digest
    from sqlalchemy import select
    from ..connectors import Session
    from ..models.database import Project
    identity = parse_project_id(secret_key)
    if not identity.ok():
        return identity
    with Session() as session:
        # Secret and suspension are checked in one fresh read, without an auth cache.
        row = session.execute(select(Project.project_secret, Project.status).where(
            Project.project_id == identity.data())).one_or_none()
        if row is None or row.status == "suspended" or not compare_digest(row.project_secret, secret_key):
            return Promise.reject(CODE.UNAUTHORIZED, "Project unavailable")
        return identity


def authenticate_scoped_key(token: str):
    from hmac import compare_digest
    from uuid import UUID
    from sqlalchemy import select, or_, func
    from ..connectors import Session
    from ..models.database import Project
    from ..models.projects import project_api_keys as keys
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
