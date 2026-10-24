"""Event time renaming preserves narrative values and all unrelated durable data."""
from copy import deepcopy
from datetime import datetime, timezone
import json
from pathlib import Path
from uuid import uuid4

from alembic import command
from alembic.config import Config
import pytest
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError

from memoia_server.env import CONFIG
from tests.test_schema_adoption import legacy_schema


def migration_config(url, monkeypatch):
    monkeypatch.setenv("DATABASE_URL", url)
    config = Config()
    config.set_main_option("script_location", str(Path(__file__).parents[1] / "migrations"))
    return config


def snapshots(connection, table):
    order = "id,project_id" if table == "user_events" else "1,2"
    return [dict(row) for row in connection.execute(text(f"SELECT * FROM {table} ORDER BY {order}")).mappings()]


def test_event_time_rename_preserves_values_and_unrelated_data(legacy_schema, monkeypatch):
    engine, url = legacy_schema
    config = migration_config(url, monkeypatch)
    command.upgrade(config, "0014_fact_time")
    uid, other_uid, blob, fact, event_id, operation = [uuid4() for _ in range(6)]
    now = datetime(2026, 10, 23, 8, 30, tzinfo=timezone.utc)
    vector = json.dumps([0.25] * CONFIG.embedding_dim)
    data_cases = [
        {"memoia_v2": True, "time": "October 2026", "content": "Keep the narrative time literal"},
        {"time": ""}, {"time": None}, {}, {"event_time": "Already current"},
        {"event_time": None}, {"time": "Same", "event_time": "Same"},
        {"time": None, "event_time": None},
        {"metadata": {"time": "User time", "event_time": "User event time"}},
        {"time": "Yesterday", "metadata": {"time": "Nested", "events": [{"time": None}]}},
        None, [], ["time"], "time",
    ]
    expected_data = {}
    unchanged_tables = ("projects", "users", "user_profiles", "user_statuses", "memory_facts",
        "memory_event_facts", "memory_sources", "memory_messages", "memory_blobs", "memory_operations",
        "memory_user_tombstones", "memory_deleted_events", "memory_profile_revisions")
    with engine.begin() as db:
        db.execute(text("INSERT INTO projects(id,project_id,project_secret,status) VALUES(:id,'event-time','fixture','active')"),
            {"id": uuid4()})
        for user_id in (uid, other_uid):
            db.execute(text("INSERT INTO users(id,project_id,additional_fields) VALUES(:id,'event-time','{\"time\":\"User metadata\"}')"),
                {"id": user_id})
        for index, data in enumerate(data_cases):
            ident = event_id if index == 0 else uuid4()
            payload = deepcopy(data)
            expected = deepcopy(payload)
            if isinstance(expected, dict) and "time" in expected:
                expected["event_time"] = expected.pop("time")
            expected_data[ident] = expected
            db.execute(text("""INSERT INTO user_events(id,user_id,project_id,event_data,embedding,revision,created_at,updated_at)
                VALUES(:id,:uid,'event-time',CAST(:data AS jsonb),CAST(:vector AS vector),7,:now,:now)"""),
                {"id": ident, "uid": uid if index % 2 else other_uid,
                 "data": json.dumps(payload), "vector": vector, "now": now})
        db.execute(text("INSERT INTO memory_sources(user_id,project_id,source_id) VALUES(:uid,'event-time','dialog')"), {"uid": other_uid})
        db.execute(text("""INSERT INTO memory_messages(user_id,project_id,source_id,message_id,content_hash,role,occurred_at)
            VALUES(:uid,'event-time','dialog','m1',repeat('a',64),'user',:now)"""), {"uid": other_uid, "now": now})
        db.execute(text("""INSERT INTO memory_blobs(id,user_id,project_id,source_id,message_ids,status)
            VALUES(:id,:uid,'event-time','dialog','["m1"]','active')"""), {"id": blob, "uid": other_uid})
        db.execute(text("""INSERT INTO memory_facts(id,user_id,project_id,blob_id,content,support_groups,occurred_at,fact_time)
            VALUES(:id,:uid,'event-time',:blob,'Fact time remains unchanged','[["m1"]]',:now,
              CAST(:fact_time AS jsonb))"""),
            {"id": fact, "uid": other_uid, "blob": blob, "now": now,
             "fact_time": json.dumps({"precision": "unknown", "evidence": [], "start": None, "end": None})})
        db.execute(text("""INSERT INTO memory_event_facts(event_id,fact_id,user_id,project_id)
            VALUES(:event,:fact,:uid,'event-time')"""), {"event": event_id, "fact": fact, "uid": other_uid})
        db.execute(text("""INSERT INTO memory_operations(id,user_id,project_id,idempotency_key,kind,request_hash,request,status,result)
            VALUES(:id,:uid,'event-time','fixed-receipt','flush',repeat('f',64),
              '{"blob_ids":[],"time":"Opaque request","metadata":{"event_time":"Retain"}}',
              'completed','{"time":"Opaque result","events":[{"time":"Retain"}]}')"""),
            {"id": operation, "uid": other_uid})
        db.execute(text("""INSERT INTO user_profiles(id,user_id,project_id,content,attributes)
            VALUES(:id,:uid,'event-time','Profile content','{"time":"Profile metadata"}')"""), {"id": uuid4(), "uid": uid})
        db.execute(text("""INSERT INTO user_statuses(id,user_id,project_id,type,attributes)
            VALUES(:id,:uid,'event-time','fixture','{"time":"Status metadata"}')"""), {"id": uuid4(), "uid": uid})
        before_events = snapshots(db, "user_events")
        before_others = {table: snapshots(db, table) for table in unchanged_tables}

    command.upgrade(config, "head")

    with engine.connect() as db:
        assert db.execute(text("SELECT version_num FROM alembic_version")).scalar_one() == "0015_event_time"
        assert snapshots(db, "user_events") == [{**row, "event_data": expected_data[row["id"]]} for row in before_events]
        for table, rows in before_others.items():
            assert snapshots(db, table) == rows, table

    with pytest.raises(RuntimeError, match="forward migration"):
        command.downgrade(config, "0014_fact_time")


@pytest.mark.parametrize("old,new", [("October", "November"), (None, "November"), ("October", None)])
def test_event_time_rename_rejects_conflicting_keys_without_changes(legacy_schema, monkeypatch, old, new):
    engine, url = legacy_schema
    config = migration_config(url, monkeypatch)
    command.upgrade(config, "0014_fact_time")
    uid = uuid4()
    with engine.begin() as db:
        db.execute(text("INSERT INTO projects(id,project_id,project_secret,status) VALUES(:id,'event-conflict','fixture','active')"),
            {"id": uuid4()})
        db.execute(text("INSERT INTO users(id,project_id) VALUES(:id,'event-conflict')"), {"id": uid})
        for payload in ({"time": "Safe to rename"}, {"time": old, "event_time": new}):
            db.execute(text("""INSERT INTO user_events(id,user_id,project_id,event_data)
                VALUES(:id,:uid,'event-conflict',CAST(:data AS jsonb))"""),
                {"id": uuid4(), "uid": uid, "data": json.dumps(payload)})
        before = snapshots(db, "user_events")

    with pytest.raises(DBAPIError, match="Event time and event_time conflict"):
        command.upgrade(config, "head")

    with engine.connect() as db:
        assert db.execute(text("SELECT version_num FROM alembic_version")).scalar_one() == "0014_fact_time"
        assert snapshots(db, "user_events") == before
