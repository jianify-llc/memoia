"""Explicit application schema preflight, never implicit import-time DDL."""
from sqlalchemy import text
from .connectors import Session
from .models.database import Project, UserEvent, UserEventGist

EXPECTED_REVISION = "0005_user_tombstones"


def check_schema():
    with Session() as session:
        revision = session.execute(text("SELECT version_num FROM alembic_version")).scalar_one()
        if revision != EXPECTED_REVISION:
            raise RuntimeError("Memoia schema is not at the required Alembic revision")
        UserEvent.check_legal_embedding_dim(session)
        UserEventGist.check_legal_embedding_dim(session)
        Project.initialize_root_project(session)
