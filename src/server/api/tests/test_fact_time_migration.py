"""The forward rename preserves temporal evidence and durable recovery identity."""
from copy import deepcopy
from datetime import datetime, timedelta, timezone
import hashlib
import json
from pathlib import Path
from uuid import uuid4

from alembic import command
from alembic.config import Config
from sqlalchemy import text

from memoia_server.controllers.source import Extraction
from memoia_server.models.source import ImportSource, UpdateFact
from tests.test_schema_adoption import legacy_schema


def test_fact_time_rename_preserves_values_and_operation_recovery(legacy_schema, monkeypatch):
    engine, url = legacy_schema
    monkeypatch.setenv("DATABASE_URL", url)
    config = Config()
    config.set_main_option("script_location", str(Path(__file__).parents[1] / "migrations"))
    command.upgrade(config, "0013_reasoning_mode")
    uid, original_blob, flush = uuid4(), uuid4(), uuid4()
    now = datetime.now(timezone.utc)
    old_time = {"start": "2026-10-01", "end": "2026-10-31", "precision": "month",
                "evidence": [{"message_id": "m1", "expression": "October"}]}
    time_values = [None, old_time,
                   {**old_time, "start": "2026-10-23", "end": "2026-10-23", "precision": "day"},
                   {**old_time, "start": "2026-01-01", "end": "2026-12-31", "precision": "year"},
                   {**old_time, "start": None, "end": None, "precision": "unknown"}]
    statement = {"content": "The user attended in October", "subject": "the user", "reporter": "the user",
                 "certainty": "asserted", "support_groups": [["m1"]], "event_time": old_time}
    candidate = {"input_fingerprint": "original-fingerprint", "extraction": {"facts": [
        statement, {**statement, "content": "The user attended on an unknown date", "event_time": None}]}}
    correction = {"fact_id": str(uuid4()), "action": "update", "expected_revision": 1, "reason": "Fixture correction"}
    cases = [
        ("correct", "processing", now + timedelta(days=1), {**correction, **statement}),
        ("correct", "failed", now - timedelta(days=1), {**correction, **statement, "event_time": None}),
        ("correct", "failed", None, correction),
        ("correct", "completed", None, correction),
        ("import", "processing", now + timedelta(days=1), {"fact_review_candidate": candidate}),
        ("import", "failed", now - timedelta(days=1), {"fact_review_candidate": candidate}),
        ("import", "processing", now + timedelta(days=1),
         {"fact_review_candidate": {"input_fingerprint": "empty", "extraction": {"facts": []}}}),
        ("import", "completed", None, {"source_id": "dialog"}),
        ("retract", "processing", None, {"message_ids": ["m1"]}),
    ]
    expected_requests = {}

    def snapshots(connection, table):
        return [dict(row) for row in connection.execute(text(f"SELECT * FROM {table} ORDER BY 1,2")).mappings()]

    with engine.begin() as db:
        db.execute(text("INSERT INTO projects(id,project_id,project_secret,status) VALUES(:id,'time','fixture','active')"), {"id": uuid4()})
        db.execute(text("INSERT INTO users(id,project_id) VALUES(:id,'time')"), {"id": uid})
        db.execute(text("INSERT INTO memory_sources(user_id,project_id,source_id) VALUES(:id,'time','dialog')"), {"id": uid})
        db.execute(text("""INSERT INTO memory_messages(user_id,project_id,source_id,message_id,content_hash,role,occurred_at)
            VALUES(:id,'time','dialog','m1',repeat('a',64),'user',:now)"""), {"id": uid, "now": now})
        db.execute(text("INSERT INTO memory_user_tombstones(project_id,user_id) VALUES('time',:id)"), {"id": uuid4()})
        db.execute(text("""INSERT INTO memory_operations(id,user_id,project_id,idempotency_key,kind,request_hash,request,status)
            VALUES(:id,:uid,'time','sealed-flush','flush',repeat('f',64),'{"blob_ids":[],"reasoning_mode":"pro"}','processing')"""),
            {"id": flush, "uid": uid})
        db.execute(text("""INSERT INTO memory_blobs(id,user_id,project_id,source_id,message_ids,status,
            fact_changes,fact_completed_at,flush_operation_id)
            VALUES(:id,:uid,'time','dialog','["m1"]','active','[]',:now,:flush)"""),
            {"id": original_blob, "uid": uid, "now": now, "flush": flush})
        for value in time_values:
            db.execute(text("""INSERT INTO memory_facts(id,user_id,project_id,blob_id,content,support_groups,occurred_at,event_time)
                VALUES(:id,:uid,'time',:bid,'Historical statement','[["m1"]]',:now,CAST(:time AS jsonb))"""),
                {"id": uuid4(), "uid": uid, "bid": original_blob, "now": now,
                 "time": json.dumps(value) if value is not None else None})
        for kind, status, expires, fields in cases:
            oid, bid = uuid4(), uuid4()
            payload = {"source_id": "dialog", "idempotency_key": str(oid), **deepcopy(fields)}
            if expires is not None and kind == "import":
                payload.update(metadata={"event_time": "user-owned"},
                    messages=[{"message_id": "m1", "role": "user", "occurred_at": now.isoformat(),
                               "content": "event_time must stay literal; the user attended in October"}])
            expected = deepcopy(payload)
            if status != "completed" and kind == "correct" and "event_time" in expected:
                expected["fact_time"] = expected.pop("event_time")
            if status != "completed" and kind == "import" and "fact_review_candidate" in expected:
                for fact in expected["fact_review_candidate"]["extraction"]["facts"]:
                    if "event_time" in fact:
                        fact["fact_time"] = fact.pop("event_time")
            expected_requests[oid] = expected
            digest = hashlib.sha256(json.dumps({"kind": kind, "request": payload}, sort_keys=True,
                separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()
            db.execute(text("""INSERT INTO memory_blobs(id,user_id,project_id,source_id,message_ids,status,kind)
                VALUES(:id,:uid,'time','dialog','["m1"]','active',:kind)"""),
                {"id": bid, "uid": uid, "kind": kind})
            db.execute(text("""INSERT INTO memory_operations(id,user_id,project_id,idempotency_key,kind,request_hash,
                request,source_id,blob_id,status,result,error,input_expires_at)
                VALUES(:id,:uid,'time',:key,:kind,:digest,CAST(:request AS jsonb),'dialog',:bid,:status,
                  CAST(:result AS jsonb),CAST(:error AS jsonb),:expires)"""),
                {"id": oid, "uid": uid, "key": str(oid), "kind": kind, "digest": digest,
                 "request": json.dumps(payload), "bid": bid, "status": status, "expires": expires,
                 "result": json.dumps({"fact_ids": [], "memory_version": 7}) if status == "completed" else None,
                 "error": json.dumps({"code": "input_required", "retryable": False}) if status == "failed" else None})
        before_facts = snapshots(db, "memory_facts")
        before_operations = snapshots(db, "memory_operations")
        unchanged_tables = {table: snapshots(db, table) for table in (
            "memory_blobs", "memory_messages", "memory_sources", "memory_user_tombstones")}

    command.upgrade(config, "0014_fact_time")

    with engine.connect() as db:
        assert db.execute(text("SELECT version_num FROM alembic_version")).scalar_one() == "0014_fact_time"
        columns = set(db.execute(text("SELECT attname FROM pg_attribute WHERE attrelid='memory_facts'::regclass AND NOT attisdropped")).scalars())
        assert "fact_time" in columns and "event_time" not in columns
        expected_facts = [{**{k: v for k, v in row.items() if k != "event_time"}, "fact_time": row["event_time"]}
                          for row in before_facts]
        assert snapshots(db, "memory_facts") == expected_facts
        expected_operations = [{**row, "request": expected_requests.get(row["id"], row["request"])}
                               for row in before_operations]
        upgraded_operations = snapshots(db, "memory_operations")
        assert upgraded_operations == expected_operations
        for row in upgraded_operations:
            payload = row["request"]
            if row["kind"] == "import" and "fact_review_candidate" in payload:
                Extraction.model_validate(payload["fact_review_candidate"]["extraction"])
                ImportSource.model_validate({k: v for k, v in payload.items() if k != "fact_review_candidate"})
            if row["kind"] == "correct" and "fact_time" in payload:
                UpdateFact.model_validate({k: v for k, v in payload.items() if k not in {"fact_id", "action", "source_id"}})
        for table, rows in unchanged_tables.items():
            assert snapshots(db, table) == rows
