"""Adopt real legacy tables without rebuilding them; reject partial/drifted contracts."""
import os
from pathlib import Path
import subprocess
import sys
from urllib.parse import urlsplit, urlunsplit, parse_qsl, urlencode
from uuid import uuid4

import pytest
from sqlalchemy import create_engine, text
from memoia_server.env import CONFIG

ROOT = Path(__file__).parents[1]


@pytest.fixture
def legacy_schema():
    schema = "memoia_adoption_" + uuid4().hex
    engine = create_engine(os.environ["DATABASE_URL"])
    with engine.begin() as connection:
        connection.execute(text(f'CREATE SCHEMA "{schema}"'))
    url = urlsplit(os.environ["DATABASE_URL"])
    query = dict(parse_qsl(url.query))
    query["options"] = f"-csearch_path={schema},public"
    database_url = urlunsplit(url._replace(query=urlencode(query)))
    scoped = create_engine(database_url)
    try:
        yield scoped, database_url
    finally:
        scoped.dispose()
        with engine.begin() as connection:
            connection.execute(text(f'DROP SCHEMA "{schema}" CASCADE'))
        engine.dispose()


def install_legacy(engine):
    ddl = (ROOT / "migrations/baseline-v1.sql").read_text().replace("__EMBEDDING_DIM__", str(CONFIG.embedding_dim))
    with engine.begin() as connection:
        for statement in ddl.split(";"):
            if statement.strip():
                connection.execute(text(statement))


def migrate(url):
    env = {**os.environ, "DATABASE_URL": url}
    # Never echo the subprocess environment or connection URL.
    return subprocess.run([sys.executable, "-m", "alembic", "upgrade", "head"], cwd=ROOT, env=env,
                          capture_output=True, text=True)


def test_existing_v1_adoption_preserves_rows_config_and_vectors(legacy_schema):
    engine, url = legacy_schema
    install_legacy(engine)
    uid = uuid4()
    with engine.begin() as connection:
        connection.execute(text("INSERT INTO projects(id,project_id,project_secret,status,profile_config) VALUES(:id,'legacy','sk-legacy-secret','active','language: zh')"), {"id": uuid4()})
        connection.execute(text("INSERT INTO users(id,project_id) VALUES(:uid,'legacy')"), {"uid": uid})
        connection.execute(text("INSERT INTO user_profiles(id,user_id,project_id,content,attributes) VALUES(:id,:uid,'legacy','Do not rebuild legacy memory','{}')"), {"id": uuid4(), "uid": uid})
    result = migrate(url)
    assert result.returncode == 0, result.stderr
    with engine.connect() as connection:
        assert connection.execute(text("SELECT version_num FROM alembic_version")).scalar_one() == "0004_key_scopes_search"
        assert connection.execute(text("SELECT profile_config FROM projects WHERE project_id='legacy'")).scalar_one() == "language: zh"
        assert connection.execute(text("SELECT content FROM user_profiles WHERE user_id=:uid"), {"uid": uid}).scalar_one() == "Do not rebuild legacy memory"
        assert connection.execute(text("SELECT count(*) FROM memory_sources")).scalar_one() == 0
    assert migrate(url).returncode == 0


@pytest.mark.parametrize("drift", ["partial", "nullable", "type", "default", "extra_column"])
def test_adoption_rejects_partial_or_drifted_schema(legacy_schema, drift):
    engine, url = legacy_schema
    install_legacy(engine)
    with engine.begin() as connection:
        if drift == "partial":
            connection.execute(text("DROP TABLE buffer_zones CASCADE"))
        elif drift == "nullable":
            connection.execute(text("ALTER TABLE projects ALTER COLUMN project_secret DROP NOT NULL"))
        elif drift == "type":
            connection.execute(text("ALTER TABLE projects ALTER COLUMN project_secret TYPE TEXT"))
        elif drift == "default":
            connection.execute(text("ALTER TABLE user_events ALTER COLUMN created_at DROP DEFAULT"))
        else:
            connection.execute(text("ALTER TABLE user_events ADD COLUMN required_plugin_value TEXT NOT NULL"))
    result = migrate(url)
    assert result.returncode != 0
    assert "contract mismatch" in result.stderr or "Incomplete v1 schema" in result.stderr
    with engine.connect() as connection:
        assert connection.execute(text("SELECT count(*) FROM pg_tables WHERE schemaname=current_schema() AND tablename='memory_sources'")).scalar_one() == 0
