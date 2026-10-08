"""Fixed Fact batches and one recoverable user-scoped flush operation."""
import hashlib
import json
from uuid import uuid4

from alembic import op
from sqlalchemy import text

revision = "0009_blob_flush"
down_revision = "0008_serial_maintenance"
branch_labels = None
depends_on = None


def upgrade():
    op.execute("""
        ALTER TABLE memory_operations ALTER COLUMN source_id DROP NOT NULL,
          ADD COLUMN lease_owner UUID, ADD COLUMN lease_until TIMESTAMPTZ,
          ADD COLUMN attempts BIGINT NOT NULL DEFAULT 0, ADD COLUMN available_at TIMESTAMPTZ;
        ALTER TABLE memory_operations DROP CONSTRAINT memory_operations_kind_check,
          ADD CONSTRAINT memory_operations_kind_check CHECK(kind IN ('import','retract','legacy_import','flush')),
          ADD CONSTRAINT ck_memory_operation_scope CHECK(
            (kind='flush' AND source_id IS NULL AND blob_id IS NULL)
            OR (kind!='flush' AND source_id IS NOT NULL)),
          ADD CONSTRAINT ck_memory_flush_lease CHECK(
            (lease_owner IS NULL)=(lease_until IS NULL) AND attempts BETWEEN 0 AND 4
            AND (kind='flush' OR (lease_owner IS NULL AND attempts=0 AND available_at IS NULL)));
        ALTER TABLE memory_blobs ADD COLUMN kind VARCHAR(16) NOT NULL DEFAULT 'import',
          ADD COLUMN fact_changes JSONB NOT NULL DEFAULT '[]',
          ADD COLUMN fact_completed_at TIMESTAMPTZ,
          ADD COLUMN flush_operation_id UUID,
          ADD CONSTRAINT ck_memory_blob_kind CHECK(kind IN ('import','retract')),
          ADD CONSTRAINT ck_memory_blob_changes CHECK(jsonb_typeof(fact_changes)='array'),
          ADD CONSTRAINT fk_memory_blob_flush FOREIGN KEY(flush_operation_id,user_id,project_id)
            REFERENCES memory_operations(id,user_id,project_id) DEFERRABLE INITIALLY DEFERRED;
        CREATE UNIQUE INDEX uq_memory_flush_executor ON memory_operations(user_id,project_id)
          WHERE kind='flush' AND lease_owner IS NOT NULL;
        CREATE INDEX idx_memory_flush_ready ON memory_operations(available_at)
          WHERE kind='flush' AND status!='completed';
        CREATE INDEX idx_memory_blob_unflushed ON memory_blobs(user_id,project_id,fact_completed_at,id)
          WHERE flush_operation_id IS NULL AND fact_completed_at IS NOT NULL;
        COMMENT ON COLUMN memory_blobs.kind IS '本固定批次的消息导入或删除操作类型';
        COMMENT ON COLUMN memory_blobs.fact_changes IS '本次事务已提交的事实变更引用及水位，不保存聊天正文';
        COMMENT ON COLUMN memory_blobs.fact_completed_at IS '事实操作提交时间，自动合批只选择已完成批次';
        COMMENT ON COLUMN memory_blobs.flush_operation_id IS '封闭后唯一所属的用户级 flush Operation，跨来源不伪造 Source';
        COMMENT ON COLUMN memory_operations.lease_owner IS 'flush 当前执行者，失败退避不持有执行权';
        COMMENT ON COLUMN memory_operations.lease_until IS 'flush 可续租执行权的截止时间';
        COMMENT ON COLUMN memory_operations.attempts IS '该固定 flush 的累计尝试次数，不因新批次而重置';
        COMMENT ON COLUMN memory_operations.available_at IS 'flush 下次允许执行时间';
    """)
    db = op.get_bind()
    # Old delete operations had no Blob. Identity and source are recoverable from
    # their own request; never guess a Source from a Fact or another user.
    for row in db.execute(text("SELECT * FROM memory_operations WHERE kind='retract' AND blob_id IS NULL")).mappings().all():
        blob_id = uuid4()
        mids = row["request"].get("message_ids", [])
        for mid in mids:
            db.execute(text("""INSERT INTO memory_messages(user_id,project_id,source_id,message_id,deleted)
              VALUES(:uid,:pid,:sid,:mid,true) ON CONFLICT DO NOTHING"""),
              dict(uid=row["user_id"], pid=row["project_id"], sid=row["source_id"], mid=mid))
        db.execute(text("""INSERT INTO memory_blobs(id,user_id,project_id,source_id,message_ids,kind,status,created_at)
          VALUES(:id,:uid,:pid,:sid,CAST(:mids AS jsonb),'retract','retracted',:created)"""),
          dict(id=blob_id, uid=row["user_id"], pid=row["project_id"], sid=row["source_id"],
               mids=json.dumps(mids), created=row["created_at"]))
        db.execute(text("UPDATE memory_operations SET blob_id=:bid WHERE id=:id"), dict(bid=blob_id, id=row["id"]))
    op.execute("""
        DROP INDEX uq_memory_import_blob;
        CREATE UNIQUE INDEX uq_memory_fact_operation_blob ON memory_operations(blob_id)
          WHERE kind IN ('import','retract');
        ALTER TABLE memory_operations ADD CONSTRAINT ck_memory_fact_operation_blob
          CHECK(kind NOT IN ('import','retract') OR blob_id IS NOT NULL);
        UPDATE memory_blobs b SET fact_completed_at=o.created_at
          FROM memory_operations o WHERE o.blob_id=b.id AND o.kind IN ('import','retract')
            AND o.status='completed' AND o.result ? 'memory_version';
    """)
    for task in db.execute(text("SELECT * FROM memory_maintenance_tasks")).mappings().all():
        rows = db.execute(text("""SELECT b.id,(o.result->>'memory_version')::bigint AS version
          FROM memory_blobs b JOIN memory_operations o ON o.blob_id=b.id
          WHERE b.user_id=:uid AND b.project_id=:pid AND o.kind IN ('import','retract')
            AND o.status='completed' AND o.result ? 'memory_version' ORDER BY version,b.id"""),
          dict(uid=task["user_id"], pid=task["project_id"])).mappings().all()
        done = min(task["profile_version"], task["event_version"])
        target = task["target_version"] or task["requested_version"]
        for row in rows:
            changes = [c for c in task["changes"] if c["version"] == row["version"]]
            db.execute(text("UPDATE memory_blobs SET fact_changes=CAST(:changes AS jsonb) WHERE id=:id"),
              dict(changes=json.dumps(changes), id=row["id"]))
        # Preserve partial phase progress as diagnostic history, not as two live
        # schedulers. Recovery recomputes both derived layers from current facts.
        ranges = [(task["task_id"] if target <= done else uuid4(), 0, done, True)] if done else []
        if target > done:
            ranges.append((task["task_id"], done, target, False))
        elif not ranges:
            ranges.append((task["task_id"], 0, 0, True))
        # Old references not backed by a Blob still need a durable recovery home.
        # Newer references with real Blobs remain unassigned for normal next flush.
        orphan_tail = [c for c in task["changes"] if c["version"] > target
                       and not any(r["version"] == c["version"] for r in rows)]
        if orphan_tail:
            ranges.append((uuid4(), target, task["requested_version"], False))
        for ident, floor, ceiling, completed in ranges:
            bids = [str(r["id"]) for r in rows if floor < r["version"] <= ceiling]
            mapped_versions = {r["version"] for r in rows if floor < r["version"] <= ceiling}
            changes = [c for c in task["changes"] if floor < c["version"] <= ceiling
                       and c["version"] not in mapped_versions]
            request = dict(blob_ids=bids, legacy_changes=changes,
                           legacy_progress=dict(profile_version=task["profile_version"],
                                                event_version=task["event_version"],
                                                requested_version=task["requested_version"]))
            result = dict(blob_ids=bids, profile_ids=[], event_ids=[], memory_version=ceiling) if completed else None
            original = ident == task["task_id"]
            error = task["last_error"] if original and not completed else None
            if original and not completed and task["lease_owner"] is not None:
                error = error or dict(code="maintenance_lease_expired", retryable=True)
            db.execute(text("""INSERT INTO memory_operations(id,user_id,project_id,idempotency_key,kind,
              request_hash,request,status,result,error,generation,attempts,available_at,created_at)
              VALUES(:id,:uid,:pid,:key,'flush',:hash,CAST(:request AS jsonb),:status,
                CAST(:result AS jsonb),CAST(:error AS jsonb),:generation,:attempts,:available,:created)"""),
              dict(id=ident, uid=task["user_id"], pid=task["project_id"], key=f"legacy-flush:{ident}",
                   hash=hashlib.sha256(json.dumps({"legacy_task": str(task["task_id"]), "ceiling": ceiling}).encode()).hexdigest(),
                   request=json.dumps(request), status="completed" if completed else "failed" if error else "processing",
                   result=json.dumps(result) if result else None, error=json.dumps(error) if error else None,
                   generation=task["generation"], attempts=task["attempts"] if original else 0,
                   available=task["available_at"] or task["updated_at"], created=task["updated_at"]))
            for bid in bids:
                db.execute(text("UPDATE memory_blobs SET flush_operation_id=:op WHERE id=:bid"),
                  dict(op=ident, bid=bid))
    op.execute("""
        CREATE FUNCTION check_memory_blob_flush() RETURNS trigger LANGUAGE plpgsql AS $$
        DECLARE batch memory_blobs;
        BEGIN
          SELECT * INTO batch FROM memory_blobs WHERE id=NEW.id;
          IF NOT FOUND OR batch.flush_operation_id IS NULL THEN RETURN NULL; END IF;
          IF batch.fact_completed_at IS NULL OR NOT EXISTS(
            SELECT 1 FROM memory_operations o WHERE o.id=batch.flush_operation_id
              AND o.user_id=batch.user_id AND o.project_id=batch.project_id AND o.kind='flush') THEN
            RAISE EXCEPTION 'invalid flush batch owner or lifecycle' USING ERRCODE='23514';
          END IF;
          RETURN NULL;
        END $$;
        CREATE CONSTRAINT TRIGGER memory_blob_flush_owner AFTER INSERT OR UPDATE ON memory_blobs
          DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_memory_blob_flush();
        CREATE FUNCTION guard_fixed_memory_batch() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF OLD.flush_operation_id IS NOT NULL AND (
            NEW.flush_operation_id IS DISTINCT FROM OLD.flush_operation_id
            OR NEW.fact_changes IS DISTINCT FROM OLD.fact_changes
            OR NEW.fact_completed_at IS DISTINCT FROM OLD.fact_completed_at
            OR NEW.message_ids IS DISTINCT FROM OLD.message_ids
            OR NEW.source_id IS DISTINCT FROM OLD.source_id) THEN
            RAISE EXCEPTION 'sealed Blob batch is immutable' USING ERRCODE='23514';
          END IF;
          RETURN NEW;
        END $$;
        CREATE TRIGGER memory_blob_fixed_batch BEFORE UPDATE ON memory_blobs
          FOR EACH ROW EXECUTE FUNCTION guard_fixed_memory_batch();
        CREATE FUNCTION guard_memory_flush_request() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF OLD.kind='flush' AND (NEW.request IS DISTINCT FROM OLD.request
            OR NEW.kind IS DISTINCT FROM OLD.kind OR NEW.request_hash IS DISTINCT FROM OLD.request_hash
            OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key) THEN
            RAISE EXCEPTION 'fixed flush identity is immutable' USING ERRCODE='23514';
          END IF;
          RETURN NEW;
        END $$;
        CREATE TRIGGER memory_flush_fixed_request BEFORE UPDATE ON memory_operations
          FOR EACH ROW EXECUTE FUNCTION guard_memory_flush_request();
        DROP TABLE memory_maintenance_tasks;
    """)


def downgrade():
    raise RuntimeError("Flush receipts are persistent business data; use a forward migration")
