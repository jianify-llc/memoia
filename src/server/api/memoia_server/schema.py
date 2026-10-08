"""Explicit application schema preflight, never implicit import-time DDL."""
from sqlalchemy import text
from .connectors import Session
from .models.database import Project, UserEvent, UserEventGist
from .env import CONFIG

EXPECTED_REVISION = "0009_blob_flush"


def check_schema():
    with Session() as session:
        revision = session.execute(text("SELECT version_num FROM alembic_version")).scalar_one()
        if revision != EXPECTED_REVISION:
            raise RuntimeError("Memoia schema is not at the required Alembic revision")
        UserEvent.check_legal_embedding_dim(session)
        UserEventGist.check_legal_embedding_dim(session)
        dimension = session.execute(text("SELECT atttypmod FROM pg_attribute "
            "WHERE attrelid='memory_facts'::regclass AND attname='embedding' AND NOT attisdropped")).scalar_one()
        if dimension != CONFIG.embedding_dim:
            raise RuntimeError("Memoia fact embedding dimension does not match configuration")
        Project.initialize_root_project(session)
