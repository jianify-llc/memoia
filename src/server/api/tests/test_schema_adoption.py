"""Adopt real legacy tables without rebuilding them; reject partial/drifted contracts."""
import os
import json
from pathlib import Path
import subprocess
import sys
from urllib.parse import urlsplit, urlunsplit, parse_qsl, urlencode
from uuid import uuid4

import pytest
from sqlalchemy import create_engine, text
from memoia_server.env import CONFIG
from memoia_server.schema import EXPECTED_REVISION

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


def migrate(url, target="head"):
    env = {**os.environ, "DATABASE_URL": url}
    # Never echo the subprocess environment or connection URL.
    return subprocess.run([sys.executable, "-m", "alembic", "upgrade", target], cwd=ROOT, env=env,
                          capture_output=True, text=True)


def test_event_time_extension_preserves_old_facts_without_invented_backfill(legacy_schema):
    engine, url = legacy_schema
    install_legacy(engine)
    assert migrate(url, "0006_source_blob_messages").returncode == 0
    uid, blob, fact = [uuid4() for _ in range(3)]
    with engine.begin() as connection:
        connection.execute(text("INSERT INTO projects(id,project_id,project_secret,status) VALUES(:id,'time-upgrade','fixture','active')"), {"id": uuid4()})
        connection.execute(text("INSERT INTO users(id,project_id) VALUES(:uid,'time-upgrade')"), {"uid": uid})
        connection.execute(text("INSERT INTO memory_sources(user_id,project_id,source_id) VALUES(:uid,'time-upgrade','dialog')"), {"uid": uid})
        connection.execute(text("INSERT INTO memory_blobs(id,user_id,project_id,source_id,message_ids,status) VALUES(:id,:uid,'time-upgrade','dialog','[\"1\"]','active')"), {"id": blob, "uid": uid})
        connection.execute(text("INSERT INTO memory_messages(user_id,project_id,source_id,message_id,content_hash,role,occurred_at) VALUES(:uid,'time-upgrade','dialog','1',repeat('a',64),'user','2026-01-01')"), {"uid": uid})
        connection.execute(text("""INSERT INTO memory_facts(id,user_id,project_id,blob_id,content,topic,sub_topic,support_groups,occurred_at)
            VALUES(:id,:uid,'time-upgrade',:blob,'Old undated Kyoto visit','life_event','travel','[[\"1\"]]','2026-01-01')"""), {"id": fact, "uid": uid, "blob": blob})
    upgraded = migrate(url)
    assert upgraded.returncode == 0, upgraded.stderr
    with engine.begin() as connection:
        row = connection.execute(text("SELECT content,occurred_at,event_time FROM memory_facts WHERE id=:id"), {"id": fact}).mappings().one()
        assert row["content"] == "Old undated Kyoto visit" and row["occurred_at"].year == 2026
        assert row["event_time"] is None
        assert connection.execute(text("SELECT time_zone FROM memory_messages WHERE user_id=:uid"), {"uid": uid}).scalar_one() is None
        assert "事件发生" in connection.execute(text("SELECT col_description('memory_facts'::regclass,attnum) FROM pg_attribute WHERE attrelid='memory_facts'::regclass AND attname='event_time'")).scalar_one()
        value = {"start": "2025-04-01", "end": "2025-04-30", "precision": "month", "evidence": [{"message_id": "1", "expression": "April 2025"}]}
        connection.execute(text("UPDATE memory_facts SET event_time=CAST(:value AS jsonb) WHERE id=:id"), {"value": json.dumps(value), "id": fact})
    refused = subprocess.run([sys.executable, "-m", "alembic", "downgrade", "0006_source_blob_messages"],
        cwd=ROOT, env={**os.environ, "DATABASE_URL": url}, capture_output=True, text=True)
    assert refused.returncode != 0 and "persistent business data" in refused.stderr
    with engine.connect() as connection:
        assert connection.execute(text("SELECT event_time FROM memory_facts WHERE id=:id"), {"id": fact}).scalar_one() == value


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
        assert connection.execute(text("SELECT version_num FROM alembic_version")).scalar_one() == EXPECTED_REVISION
        assert connection.execute(text("SELECT profile_config FROM projects WHERE project_id='legacy'")).scalar_one() == "language: zh"
        assert connection.execute(text("SELECT content FROM user_profiles WHERE user_id=:uid"), {"uid": uid}).scalar_one() == "Do not rebuild legacy memory"
        assert connection.execute(text("SELECT count(*) FROM memory_sources")).scalar_one() == 0
        assert connection.execute(text("SELECT count(*) FROM memory_user_tombstones")).scalar_one() == 0
    assert migrate(url).returncode == 0


def test_v2_upgrade_adds_only_persistent_identity_tombstones(legacy_schema):
    engine, url = legacy_schema
    install_legacy(engine)
    assert migrate(url, "0004_key_scopes_search").returncode == 0
    uid = uuid4()
    with engine.begin() as connection:
        connection.execute(text("INSERT INTO projects(id,project_id,project_secret,status) VALUES(:id,'upgrade','test-only','active')"), {"id": uuid4()})
        connection.execute(text("INSERT INTO users(id,project_id) VALUES(:uid,'upgrade')"), {"uid": uid})
        connection.execute(text("INSERT INTO user_profiles(id,user_id,project_id,content,attributes) VALUES(:id,:uid,'upgrade','Preserve until explicit forgetting','{}')"),
                           {"id": uuid4(), "uid": uid})
    upgraded = migrate(url)
    assert upgraded.returncode == 0, upgraded.stderr
    with engine.begin() as connection:
        assert connection.execute(text("SELECT version_num FROM alembic_version")).scalar_one() == EXPECTED_REVISION
        assert connection.execute(text("SELECT content FROM user_profiles WHERE user_id=:uid"), {"uid": uid}).scalar_one() == "Preserve until explicit forgetting"
        connection.execute(text("INSERT INTO memory_user_tombstones(project_id,user_id) VALUES('upgrade',:uid)"), {"uid": uid})
        connection.execute(text("DELETE FROM users WHERE project_id='upgrade' AND id=:uid"), {"uid": uid})
        assert connection.execute(text("SELECT count(*) FROM memory_user_tombstones WHERE user_id=:uid"), {"uid": uid}).scalar_one() == 1
        connection.execute(text("DELETE FROM projects WHERE project_id='upgrade'"))
        assert connection.execute(text("SELECT count(*) FROM memory_user_tombstones WHERE user_id=:uid"), {"uid": uid}).scalar_one() == 0


@pytest.mark.parametrize("target,support_message", [
    ("0006_source_blob_messages", "m1"), ("head", "m1"), ("head", "missing"),
])
def test_group_upgrade_scrubs_completed_copies_preserves_pending_and_manual_metadata(legacy_schema, target, support_message):
    engine, url = legacy_schema
    install_legacy(engine)
    assert migrate(url, "0005_user_tombstones").returncode == 0
    uid, blob, completed, pending, manual = [uuid4() for _ in range(5)]
    message = {"message_id": "m1", "role": "user", "content": "private raw input marker", "occurred_at": "2026-01-01T00:00:00+00:00"}
    body = {"idempotency_key": "old", "external_id": "old-log", "messages": [message], "metadata": {}}
    with engine.begin() as connection:
        connection.execute(text("INSERT INTO projects(id,project_id,project_secret,status) VALUES(:id,'upgrade','fixture','active')"), {"id": uuid4()})
        connection.execute(text("INSERT INTO users(id,project_id) VALUES(:uid,'upgrade')"), {"uid": uid})
        connection.execute(text("""INSERT INTO memory_sources(id,user_id,project_id,external_id,payload,request_hash,status)
            VALUES(:id,:uid,'upgrade','old-log',CAST(:body AS jsonb),'old-digest','active')"""), {"id": blob, "uid": uid, "body": json.dumps(body)})
        for operation, status in [(completed, "completed"), (pending, "processing")]:
            connection.execute(text("""INSERT INTO memory_operations(id,user_id,project_id,idempotency_key,kind,request_hash,request,external_id,source_id,status,result)
                VALUES(:id,:uid,'upgrade',:key,'import','old-digest',CAST(:body AS jsonb),:key,:blob,:status,CAST(:result AS jsonb))"""),
                {"id": operation, "uid": uid, "key": str(operation), "body": json.dumps({**body, "idempotency_key": str(operation)}),
                 "blob": blob if status == "completed" else None, "status": status,
                 "result": json.dumps({"event_ids": [], "profile_ids": []}) if status == "completed" else None})
        connection.execute(text("""INSERT INTO memory_facts(id,user_id,project_id,source_id,content,topic,sub_topic,support_groups,occurred_at)
            VALUES(:id,:uid,'upgrade',:blob,'Concise fact','work','city',CAST(:support AS jsonb),'2026-01-01')"""),
            {"id": uuid4(), "uid": uid, "blob": blob, "support": json.dumps([[support_message]])})
        connection.execute(text("""INSERT INTO user_profiles(id,user_id,project_id,content,attributes)
            VALUES(:id,:uid,'upgrade','Manual profile',CAST(:attributes AS jsonb))"""),
            {"id": manual, "uid": uid, "attributes": json.dumps({"source_id": "manual-origin", "source_ids": ["manual-origin"]})})
        for status in ["done", "processing"]:
            bid = uuid4()
            connection.execute(text("""INSERT INTO general_blobs(id,user_id,project_id,blob_type,blob_data)
                VALUES(:id,:uid,'upgrade','chat',CAST(:body AS jsonb))"""), {"id": bid, "uid": uid, "body": json.dumps({"messages": [message]})})
            connection.execute(text("""INSERT INTO buffer_zones(id,user_id,project_id,blob_type,blob_id,token_size,status)
                VALUES(:id,:uid,'upgrade','chat',:blob,10,:status)"""), {"id": uuid4(), "uid": uid, "blob": bid, "status": status})
    # 分别验证单版接纳和带旧事实的连续升级，不能只用空库证明迁移链可执行。
    upgraded = migrate(url, target)
    if support_message == "missing":
        assert upgraded.returncode != 0 and "support outside active source messages" in upgraded.stderr
        with engine.connect() as connection:
            assert connection.scalar(text("SELECT version_num FROM alembic_version")) == "0005_user_tombstones"
            assert connection.scalar(text("SELECT payload FROM memory_sources WHERE id=:id"), {"id": blob}) == body
            assert connection.scalar(text("SELECT request FROM memory_operations WHERE id=:id"),
                                     {"id": completed})["messages"] == [message]
            assert connection.scalar(text("SELECT to_regclass(current_schema() || '.memory_blobs')")) is None
        return
    assert upgraded.returncode == 0, upgraded.stderr
    with engine.connect() as connection:
        assert connection.scalar(text("SELECT version_num FROM alembic_version")) == (
            EXPECTED_REVISION if target == "head" else target)
        done = connection.execute(text("SELECT * FROM memory_operations WHERE id=:id"), {"id": completed}).mappings().one()
        assert "messages" not in done["request"] and done["input_expires_at"] is None
        unfinished = connection.execute(text("SELECT * FROM memory_operations WHERE id=:id"), {"id": pending}).mappings().one()
        assert unfinished["request"]["messages"] == [message] and unfinished["input_expires_at"] is not None
        assert unfinished["source_id"] == "legacy:" + str(pending) and unfinished["blob_id"] == pending
        assert connection.execute(text("SELECT processed FROM memory_messages WHERE source_id=:sid"), {"sid": unfinished["source_id"]}).scalar_one() is False
        assert connection.execute(text("SELECT count(*) FROM general_blobs")).scalar_one() == 1
        assert connection.execute(text("SELECT status FROM buffer_zones")).scalar_one() == "processing"
        assert connection.execute(text("SELECT attributes FROM user_profiles WHERE id=:id"), {"id": manual}).scalar_one() == {"source_id": "manual-origin", "source_ids": ["manual-origin"]}
        assert connection.execute(text("SELECT count(*) FROM memory_blobs")).scalar_one() == 2
        assert connection.execute(text("SELECT count(*) FROM information_schema.columns WHERE table_schema=current_schema() AND table_name IN ('memory_sources','memory_blobs') AND column_name='payload'")).scalar_one() == 0


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
