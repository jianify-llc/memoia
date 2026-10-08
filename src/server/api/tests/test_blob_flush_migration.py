"""Upgrade populated 0008 state without re-extracting purged input or losing retries."""
import json
from uuid import uuid4

import pytest
from sqlalchemy import text
from tests.test_schema_adoption import legacy_schema, install_legacy, migrate


@pytest.mark.parametrize("mode", ["pending", "partial", "failed", "completed", "running"])
def test_populated_maintenance_becomes_fixed_flush_with_history(legacy_schema, mode):
    engine, url = legacy_schema
    install_legacy(engine)
    result = migrate(url, "0008_serial_maintenance")
    assert result.returncode == 0, result.stderr
    uid, task, bids = uuid4(), uuid4(), [uuid4() for _ in range(3)]
    refs = [{"kind": "deleted", "fact_id": str(uuid4()), "version": v} for v in (1, 2, 3)]
    done = 2 if mode == "completed" else 1 if mode == "partial" else 0
    attempts = 4 if mode == "failed" else 1 if mode == "running" else 0
    error = {"code": "model_unavailable", "retryable": True} if mode == "failed" else None
    with engine.begin() as db:
        db.execute(text("INSERT INTO projects(id,project_id,project_secret,status) VALUES(:id,'fixture','not-a-secret','active')"), {"id": uuid4()})
        db.execute(text("INSERT INTO users(id,project_id) VALUES(:uid,'fixture')"), {"uid": uid})
        db.execute(text("INSERT INTO memory_sources(user_id,project_id,source_id) VALUES(:uid,'fixture','dialog')"), {"uid": uid})
        for version, bid in enumerate(bids, 1):
            message_id = f"m{version}"
            db.execute(text("""INSERT INTO memory_messages(user_id,project_id,source_id,message_id,
              content_hash,role,occurred_at) VALUES(:uid,'fixture','dialog',:mid,repeat('a',64),'user',now())"""),
              dict(uid=uid, mid=message_id))
            db.execute(text("""INSERT INTO memory_blobs(id,user_id,project_id,source_id,message_ids,status)
              VALUES(:bid,:uid,'fixture','dialog',CAST(:mids AS jsonb),'active')"""),
              dict(bid=bid, uid=uid, mids=json.dumps([message_id])))
            db.execute(text("""INSERT INTO memory_operations(id,user_id,project_id,idempotency_key,kind,
              request_hash,request,source_id,blob_id,status,result)
              VALUES(:id,:uid,'fixture',:key,'import',repeat('a',64),'{}','dialog',:bid,'completed',CAST(:result AS jsonb))"""),
              dict(id=uuid4(), uid=uid, key=f"batch-{version}", bid=bid,
                   result=json.dumps({"memory_version": version, "profile_ids": [], "event_ids": [], "fact_ids": []})))
        db.execute(text("""INSERT INTO memory_maintenance_tasks(task_id,user_id,project_id,requested_version,
          profile_version,event_version,target_version,changes,attempts,last_error,available_at,lease_owner,lease_until)
          VALUES(:id,:uid,'fixture',3,:profile,:done,2,CAST(:changes AS jsonb),:attempts,
            CAST(:error AS jsonb),now(),:owner,CASE WHEN :running THEN now()+interval '60 seconds' ELSE NULL END)"""),
          dict(id=task, uid=uid, done=done, profile=2 if mode == "partial" else done,
               changes=json.dumps(refs), attempts=attempts,
               error=json.dumps(error) if error else None, owner=uuid4() if mode == "running" else None,
               running=mode == "running"))
    result = migrate(url)
    assert result.returncode == 0, result.stderr
    with engine.connect() as db:
        assert db.scalar(text("SELECT to_regclass('memory_maintenance_tasks')")) is None
        original = db.execute(text("SELECT * FROM memory_operations WHERE id=:id"), {"id": task}).mappings().one()
        assert original["kind"] == "flush" and original["source_id"] is None and original["blob_id"] is None
        assert original["attempts"] == attempts and original["lease_owner"] is None
        if error:
            assert original["error"] == error and original["status"] == "failed"
        if mode == "running":
            assert original["error"]["code"] == "maintenance_lease_expired"
        if mode == "completed":
            assert original["status"] == "completed"
        assert original["request"]["blob_ids"] == [str(b) for b in bids[done if done < 2 else 0:2]]
        batches = db.execute(text("SELECT * FROM memory_blobs ORDER BY fact_completed_at,id")).mappings().all()
        by_id = {row["id"]: row for row in batches}
        assert by_id[bids[2]]["flush_operation_id"] is None
        assert by_id[bids[2]]["fact_changes"] == [refs[2]]
        assert all(row["fact_completed_at"] is not None for row in batches)
        assert db.scalar(text("SELECT count(*) FROM memory_operations WHERE kind='import' AND request!='{}'")) == 0


def test_legacy_unknown_delete_and_unmapped_tail_keep_recovery_identity(legacy_schema):
    engine, url = legacy_schema
    install_legacy(engine)
    assert migrate(url, "0008_serial_maintenance").returncode == 0
    uid, deletion, task = uuid4(), uuid4(), uuid4()
    refs = [{"kind": "deleted", "fact_id": str(uuid4()), "version": v} for v in (1, 2)]
    with engine.begin() as db:
        db.execute(text("INSERT INTO projects(id,project_id,project_secret,status) VALUES(:id,'fixture','not-a-secret','active')"), {"id": uuid4()})
        db.execute(text("INSERT INTO users(id,project_id) VALUES(:uid,'fixture')"), {"uid": uid})
        db.execute(text("INSERT INTO memory_sources(user_id,project_id,source_id) VALUES(:uid,'fixture','dialog')"), {"uid": uid})
        db.execute(text("""INSERT INTO memory_operations(id,user_id,project_id,idempotency_key,kind,
          request_hash,request,source_id,status,error) VALUES(:id,:uid,'fixture','deletion','retract',
          repeat('a',64),'{"message_ids":["missing"]}','dialog','failed',CAST(:error AS jsonb))"""),
          dict(id=deletion, uid=uid, error=json.dumps({"code": "lease_lost", "retryable": True})))
        db.execute(text("""INSERT INTO memory_maintenance_tasks(task_id,user_id,project_id,
          requested_version,target_version,changes,attempts,last_error)
          VALUES(:id,:uid,'fixture',2,1,CAST(:refs AS jsonb),4,CAST(:error AS jsonb))"""),
          dict(id=task, uid=uid, refs=json.dumps(refs),
               error=json.dumps({"code": "maintenance_capacity", "retryable": False})))
    result = migrate(url)
    assert result.returncode == 0, result.stderr
    with engine.connect() as db:
        assert db.scalar(text("SELECT deleted FROM memory_messages WHERE message_id='missing'")) is True
        row = db.execute(text("SELECT * FROM memory_operations WHERE id=:id"), {"id": deletion}).mappings().one()
        assert row["blob_id"] and row["status"] == "failed" and row["request"]["message_ids"] == ["missing"]
        batch = db.execute(text("SELECT * FROM memory_blobs WHERE id=:id"), {"id": row["blob_id"]}).mappings().one()
        assert batch["kind"] == "retract" and batch["fact_completed_at"] is None
        flushes = db.execute(text("SELECT * FROM memory_operations WHERE kind='flush'")).mappings().all()
        assert {str(f["id"]) for f in flushes}.issuperset({str(task)})
        assert sorted(c["version"] for f in flushes for c in f["request"]["legacy_changes"]) == [1, 2]
        original = next(f for f in flushes if f["id"] == task)
        tail = next(f for f in flushes if f["id"] != task)
        assert original["attempts"] == 4 and original["status"] == "failed"
        assert original["error"] == {"code": "maintenance_capacity", "retryable": False}
        assert tail["attempts"] == 0 and tail["status"] == "processing" and tail["error"] is None
