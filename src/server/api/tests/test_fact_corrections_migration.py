"""A forward upgrade preserves unknown historical Fact timestamps."""
from pathlib import Path
from uuid import uuid4

from alembic import command
from alembic.config import Config
from sqlalchemy import text

from tests.test_schema_adoption import legacy_schema


def test_legacy_timestamp_nulls_and_new_database_defaults(legacy_schema, monkeypatch):
    engine, url = legacy_schema
    monkeypatch.setenv("DATABASE_URL", url)
    config = Config()
    config.set_main_option("script_location", str(Path(__file__).parents[1] / "migrations"))
    command.upgrade(config, "0011_retire_gists")
    uid, bid, old_fid, new_fid = uuid4(), uuid4(), uuid4(), uuid4()
    with engine.begin() as connection:
        connection.execute(text("INSERT INTO projects(id,project_id,project_secret,status) VALUES(:id,'correction','fixture','active')"), {"id": uuid4()})
        connection.execute(text("INSERT INTO users(id,project_id) VALUES(:id,'correction')"), {"id": uid})
        connection.execute(text("INSERT INTO memory_sources(user_id,project_id,source_id) VALUES(:id,'correction','dialog')"), {"id": uid})
        connection.execute(text("""INSERT INTO memory_messages(user_id,project_id,source_id,message_id,content_hash,role,occurred_at)
            VALUES(:id,'correction','dialog','m1',repeat('a',64),'user',now())"""), {"id": uid})
        connection.execute(text("""INSERT INTO memory_blobs(id,user_id,project_id,source_id,message_ids,status)
            VALUES(:bid,:uid,'correction','dialog','["m1"]','active')"""), {"bid": bid, "uid": uid})
        connection.execute(text("""INSERT INTO memory_facts(id,user_id,project_id,blob_id,content,support_groups,occurred_at)
            VALUES(:fid,:uid,'correction',:bid,'Historical statement','[["m1"]]',now())"""),
            {"fid": old_fid, "uid": uid, "bid": bid})
    command.upgrade(config, "head")
    with engine.begin() as connection:
        assert tuple(connection.execute(text("SELECT created_at,updated_at FROM memory_facts WHERE id=:id"), {"id": old_fid}).one()) == (None, None)
        connection.execute(text("""INSERT INTO memory_facts(id,user_id,project_id,blob_id,content,support_groups,occurred_at)
            VALUES(:fid,:uid,'correction',:bid,'New statement','[["m1"]]',now())"""),
            {"fid": new_fid, "uid": uid, "bid": bid})
        created, updated = connection.execute(text("SELECT created_at,updated_at FROM memory_facts WHERE id=:id"), {"id": new_fid}).one()
        assert created is not None and created == updated
        assert connection.execute(text("SELECT content FROM memory_facts WHERE id=:id"), {"id": old_fid}).scalar_one() == "Historical statement"
