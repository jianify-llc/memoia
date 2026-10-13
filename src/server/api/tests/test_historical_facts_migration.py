"""The forward migration deletes only previously hidden facts, never raw identities."""
import json
from uuid import uuid4

import pytest
from sqlalchemy import text

from tests.test_schema_adoption import legacy_schema, install_legacy, migrate


@pytest.mark.parametrize("hidden_count", [1, 1001])
def test_hidden_facts_are_deleted_with_scoped_recoverable_derived_repair(legacy_schema, hidden_count):
    engine, url = legacy_schema
    install_legacy(engine)
    before = migrate(url, "0009_blob_flush")
    assert before.returncode == 0, before.stderr
    uid, other, blob, hidden, kept, event, operation, prior_flush = [uuid4() for _ in range(8)]
    hidden_ids = [hidden, *[uuid4() for _ in range(hidden_count - 1)]]
    history = [{"id": str(uuid4()), "content": "removed history", "fact_ids": [str(hidden)]},
               {"id": str(uuid4()), "content": "preserved history", "fact_ids": [str(kept)]}]
    with engine.begin() as db:
        db.execute(text("INSERT INTO projects(id,project_id,project_secret,status,profile_config) VALUES(:id,'historical','fixture','active','language: zh')"), {"id": uuid4()})
        db.execute(text("INSERT INTO users(id,project_id) VALUES(:id,'historical')"), [{"id": uid}, {"id": other}])
        db.execute(text("INSERT INTO memory_sources(user_id,project_id,source_id) VALUES(:uid,'historical','dialog')"), {"uid": uid})
        db.execute(text("""INSERT INTO memory_messages(user_id,project_id,source_id,message_id,content_hash,role,occurred_at,processed,deleted)
          VALUES(:uid,'historical','dialog',:mid,repeat('a',64),'user',now(),true,:deleted)"""),
          [{"uid": uid, "mid": mid, "deleted": mid == "tombstone"} for mid in ["m1", "m2", "tombstone"]])
        db.execute(text("""INSERT INTO memory_blobs(id,user_id,project_id,source_id,message_ids,status,fact_completed_at,fact_changes)
          VALUES(:id,:uid,'historical','dialog','["m1","m2"]','active',now(),CAST(:changes AS jsonb))"""),
          {"id": blob, "uid": uid, "changes": json.dumps([dict(kind="added", fact_id=str(hidden), version=1)])})
        db.execute(text("""INSERT INTO memory_facts(id,user_id,project_id,blob_id,content,support_groups,occurred_at,active)
          VALUES(:id,:uid,'historical',:blob,:content,CAST(:groups AS jsonb),now(),:active)"""), [
            *[{"id": fid, "uid": uid, "blob": blob, "content": "hidden", "groups": '[["m1"]]', "active": False}
              for fid in hidden_ids],
            {"id": kept, "uid": uid, "blob": blob, "content": "still supported", "groups": '[["m2"]]', "active": True}])
        db.execute(text("""INSERT INTO user_events(id,user_id,project_id,event_data)
          VALUES(:id,:uid,'historical','{"event_tip": "unchanged story","memoia_v2": true}')"""), {"id": event, "uid": uid})
        db.execute(text("INSERT INTO memory_event_facts(user_id,project_id,event_id,fact_id) VALUES(:uid,'historical',:eid,:fid)"),
          [{"uid": uid, "eid": event, "fid": fid} for fid in [hidden, kept]])
        db.execute(text("""INSERT INTO memory_profile_revisions(id,user_id,project_id,profiles,added,removed)
          VALUES(:id,:uid,'historical',CAST(:items AS jsonb),CAST(:items AS jsonb),CAST(:items AS jsonb))"""),
          {"id": uuid4(), "uid": uid, "items": json.dumps(history)})
        db.execute(text("""INSERT INTO memory_operations(id,user_id,project_id,source_id,blob_id,idempotency_key,
          kind,request_hash,request,status,result) VALUES(:id,:uid,'historical','dialog',:blob,'original-import',
          'import',repeat('a',64),'{}','completed','{"fact_ids": [],"event_ids": [],"profile_ids": [],"memory_version": 1}')"""),
          {"id": operation, "uid": uid, "blob": blob})
        db.execute(text("""INSERT INTO memory_operations(id,user_id,project_id,idempotency_key,kind,request_hash,request,status,result)
          VALUES(:id,:uid,'historical','sealed','flush',repeat('b',64),CAST(:request AS jsonb),'completed',
          '{"blob_ids": [],"event_ids": [],"profile_ids": []}')"""),
          {"id": prior_flush, "uid": uid, "request": json.dumps({"blob_ids": [str(blob)]})})
        db.execute(text("UPDATE memory_blobs SET flush_operation_id=:flush WHERE id=:blob"), {"flush": prior_flush, "blob": blob})
        original = dict(db.execute(text("SELECT * FROM memory_operations WHERE id=:id"), {"id": operation}).mappings().one())
        batch = dict(db.execute(text("SELECT * FROM memory_blobs WHERE id=:id"), {"id": blob}).mappings().one())
    result = migrate(url)
    assert result.returncode == 0, result.stderr
    with engine.connect() as db:
        assert db.execute(text("SELECT id FROM memory_facts ORDER BY id")).scalars().all() == [kept]
        assert dict(db.execute(text("SELECT * FROM memory_operations WHERE id=:id"), {"id": operation}).mappings().one()) == original
        assert dict(db.execute(text("SELECT * FROM memory_blobs WHERE id=:id"), {"id": blob}).mappings().one()) == batch
        assert db.scalar(text("SELECT count(*) FROM users WHERE project_id='historical'")) == 2
        assert db.scalar(text("SELECT count(*) FROM memory_messages WHERE processed")) == 3
        assert db.scalar(text("SELECT deleted FROM memory_messages WHERE message_id='tombstone'")) is True
        story = db.scalar(text("SELECT event_data FROM user_events WHERE id=:id"), {"id": event})
        assert story["event_tip"] == "unchanged story"
        assert set(story["fact_ids"]) == {str(hidden), str(kept)}
        assert db.execute(text("SELECT fact_id FROM memory_event_facts")).scalars().all() == [kept]
        row = db.execute(text("SELECT profiles,added,removed FROM memory_profile_revisions")).one()
        assert all(items == [history[1]] for items in row)
        repairs = db.execute(text("SELECT * FROM memory_operations WHERE idempotency_key LIKE 'historical-facts:%'")).mappings().all()
        assert len(repairs) == (hidden_count + 999) // 1000
        recovered_ids = []
        for repair in repairs:
            assert repair["user_id"] == uid and repair["project_id"] == "historical"
            assert repair["status"] == "processing" and repair["source_id"] is None and repair["blob_id"] is None
            assert repair["request"]["blob_ids"] == []
            changes = repair["request"]["legacy_changes"]
            assert 1 <= len(changes) <= 1000
            assert len(json.dumps(changes).encode()) < 256 * 1024
            assert all(change["kind"] == "deleted" and change["version"] == 1 for change in changes)
            recovered_ids.extend(change["fact_id"] for change in changes)
        assert sorted(recovered_ids) == sorted(map(str, hidden_ids))
        assert db.scalar(text("SELECT to_regclass('memory_fact_corrections')")) is None
        assert db.scalar(text("SELECT count(*) FROM pg_attribute WHERE attrelid='memory_facts'::regclass AND attname='active' AND NOT attisdropped")) == 0
        index = db.scalar(text("SELECT pg_get_indexdef('idx_memory_facts_lexical'::regclass)"))
        assert "WHERE" not in index
        assert db.scalar(text("SELECT to_regclass('idx_memory_event_facts_reverse')")) is not None
    assert migrate(url).returncode == 0
