"""The cascade migration preserves data and the owner-scoped FK."""
from pathlib import Path
from uuid import uuid4

from alembic import command
from alembic.config import Config
import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from memoia_server.schema import EXPECTED_REVISION
from tests.test_schema_adoption import legacy_schema


def test_source_cascade_upgrade_preserves_data_and_owner_constraints(legacy_schema, monkeypatch):
    engine, url = legacy_schema
    monkeypatch.setenv("DATABASE_URL", url)
    config = Config()
    config.set_main_option("script_location", str(Path(__file__).parents[1] / "migrations"))
    command.upgrade(config, "0015_event_time")
    uid, other, blob = uuid4(), uuid4(), uuid4()
    tables = ("projects", "users", "memory_sources", "memory_messages", "memory_blobs",
              "memory_facts", "memory_operations", "memory_user_tombstones")

    def snapshots(db):
        return {name: [dict(row) for row in db.execute(text(f"SELECT * FROM {name} ORDER BY 1,2")).mappings()]
                for name in tables}

    with engine.begin() as db:
        for pid in ("cascade", "other"):
            db.execute(text("INSERT INTO projects(id,project_id,project_secret,status) VALUES(:id,:pid,'fixture','active')"),
                       {"id": uuid4(), "pid": pid})
        for owner, pid in ((uid, "cascade"), (other, "cascade"), (uid, "other")):
            db.execute(text("INSERT INTO users(id,project_id) VALUES(:uid,:pid)"), {"uid": owner, "pid": pid})
        db.execute(text("INSERT INTO memory_sources(user_id,project_id,source_id) VALUES(:uid,'cascade','dialog')"), {"uid": uid})
        db.execute(text("""INSERT INTO memory_messages(user_id,project_id,source_id,message_id,content_hash,role,occurred_at)
            VALUES(:uid,'cascade','dialog','m1',repeat('a',64),'user',now())"""), {"uid": uid})
        db.execute(text("""INSERT INTO memory_blobs(id,user_id,project_id,source_id,message_ids,status)
            VALUES(:id,:uid,'cascade','dialog','["m1"]','active')"""), {"id": blob, "uid": uid})
        db.execute(text("""INSERT INTO memory_facts(id,user_id,project_id,blob_id,content,support_groups,occurred_at)
            VALUES(:id,:uid,'cascade',:blob,'Preserve this memory','[["m1"]]',now())"""),
                   {"id": uuid4(), "uid": uid, "blob": blob})
        db.execute(text("""INSERT INTO memory_operations(id,user_id,project_id,idempotency_key,kind,request_hash,request,status,result)
            VALUES(:id,:uid,'cascade','receipt','flush',repeat('f',64),'{"blob_ids":[]}',
                'completed',CAST(:result AS jsonb))"""), {"id": uuid4(), "uid": uid, "result": '{"memory_version":7}'})
        db.execute(text("INSERT INTO memory_user_tombstones(project_id,user_id) VALUES('cascade',:id)"), {"id": uuid4()})
        before = snapshots(db)
        function_ids = db.execute(text("""SELECT 'check_memory_message_delete()'::regprocedure::oid,
            'check_memory_blob_messages()'::regprocedure::oid""")).one()

    command.upgrade(config, "head")

    with engine.connect() as db:
        assert snapshots(db) == before
        assert db.execute(text("SELECT version_num FROM alembic_version")).scalar_one() == EXPECTED_REVISION
        names = set(db.execute(text("SELECT conname FROM pg_constraint WHERE conrelid='memory_facts'::regclass AND contype='f'")).scalars())
        assert "memory_facts_source_id_fkey" not in names
        assert "memory_facts_blob_id_user_id_project_id_fkey" in names
        assert db.execute(text("""SELECT 'check_memory_message_delete()'::regprocedure::oid,
            'check_memory_blob_messages()'::regprocedure::oid""")).one() == function_ids
    for owner, pid in ((other, "cascade"), (uid, "other")):
        with pytest.raises(IntegrityError) as error, engine.begin() as db:
            db.execute(text("""INSERT INTO memory_facts(id,user_id,project_id,blob_id,content,support_groups,occurred_at)
                VALUES(:id,:uid,:pid,:blob,'Wrong owner','[["m1"]]',now())"""),
                       {"id": uuid4(), "uid": owner, "pid": pid, "blob": blob})
        assert error.value.orig.pgcode == "23503"
