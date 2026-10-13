"""Only obsolete indexes disappear; no unsupported conversion into Facts."""
from uuid import uuid4

from sqlalchemy import text
from tests.test_schema_adoption import legacy_schema, install_legacy, migrate


def test_retirement_preserves_event_body_and_adds_message_membership_index(legacy_schema):
    engine, url = legacy_schema
    install_legacy(engine)
    before = migrate(url, "0010_historical_facts")
    assert before.returncode == 0, before.stderr
    uid, event, gist = uuid4(), uuid4(), uuid4()
    with engine.begin() as connection:
        connection.execute(text("INSERT INTO projects(id,project_id,project_secret,status) VALUES(:id,'retirement','fixture','active')"), {"id": uuid4()})
        connection.execute(text("INSERT INTO users(id,project_id) VALUES(:id,'retirement')"), {"id": uid})
        connection.execute(text("INSERT INTO user_events(id,user_id,project_id,event_data) VALUES(:id,:uid,'retirement',:body)"),
                           {"id": event, "uid": uid, "body": '{"event_tip":"Preserved story"}'})
        connection.execute(text("INSERT INTO user_event_gists(id,user_id,project_id,event_id,gist_data) VALUES(:id,:uid,'retirement',:event,:body)"),
                           {"id": gist, "uid": uid, "event": event, "body": '{"content":"Unsupported index-only detail"}'})
    after = migrate(url)
    assert after.returncode == 0, after.stderr
    with engine.begin() as connection:
        assert connection.execute(text("SELECT event_data FROM user_events WHERE id=:id"), {"id": event}).scalar_one() == {"event_tip": "Preserved story"}
        assert connection.execute(text("SELECT count(*) FROM memory_facts")).scalar_one() == 0
        assert connection.execute(text("SELECT count(*) FROM pg_tables WHERE schemaname=current_schema() AND tablename='user_event_gists'")).scalar_one() == 0
        connection.execute(text("INSERT INTO memory_sources(user_id,project_id,source_id) VALUES(:uid,'retirement','dialog')"), {"uid": uid})
        connection.execute(text("""INSERT INTO memory_messages(user_id,project_id,source_id,message_id,role,content_hash,occurred_at)
            SELECT :uid,'retirement','dialog','message-' || n,'user',repeat('a',64),now()
            FROM generate_series(1,10000) n"""), {"uid": uid})
        connection.execute(text("""INSERT INTO memory_blobs(id,user_id,project_id,source_id,message_ids,status)
            SELECT gen_random_uuid(),:uid,'retirement','dialog',jsonb_build_array('message-' || n),'active'
            FROM generate_series(1,10000) n"""), {"uid": uid})
        connection.execute(text("ANALYZE memory_blobs"))
        plan = connection.execute(text("""EXPLAIN (ANALYZE, FORMAT JSON) SELECT id FROM memory_blobs
            WHERE user_id=:uid AND project_id='retirement' AND source_id='dialog'
              AND message_ids ?| ARRAY['message-5555']"""), {"uid": uid}).scalar_one()
        assert "idx_memory_blobs_message_ids" in str(plan)
        assert plan[0]["Plan"]["Actual Rows"] == 1
