"""Separate external source groups from processing blobs; purge completed input copies."""
import hashlib
import json
from datetime import datetime, timezone

from alembic import op
from sqlalchemy import text

revision = "0006_source_blob_messages"
down_revision = "0005_user_tombstones"
branch_labels = None
depends_on = None


def _hash(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()


def upgrade():
    db = op.get_bind()
    op.execute("ALTER TABLE memory_sources RENAME TO memory_blobs")
    op.execute("ALTER TABLE memory_facts RENAME COLUMN source_id TO blob_id")
    op.execute("ALTER TABLE memory_operations RENAME COLUMN source_id TO blob_id")
    op.execute("ALTER TABLE memory_blobs ADD COLUMN source_id VARCHAR(255), ADD COLUMN message_ids JSONB")
    op.execute("ALTER TABLE memory_operations ADD COLUMN source_id VARCHAR(255), ADD COLUMN input_expires_at TIMESTAMPTZ")
    op.execute("""CREATE TABLE memory_sources (
        user_id UUID NOT NULL, project_id VARCHAR(64) NOT NULL, source_id VARCHAR(255) NOT NULL,
        legacy BOOLEAN NOT NULL DEFAULT false, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY(user_id, project_id, source_id),
        FOREIGN KEY(user_id, project_id) REFERENCES users(id, project_id) ON DELETE CASCADE)""")
    op.execute("""CREATE TABLE memory_messages (
        user_id UUID NOT NULL, project_id VARCHAR(64) NOT NULL, source_id VARCHAR(255) NOT NULL,
        message_id VARCHAR(255) NOT NULL, content_hash VARCHAR(64), role VARCHAR(16), occurred_at TIMESTAMPTZ,
        processed BOOLEAN NOT NULL DEFAULT false, deleted BOOLEAN NOT NULL DEFAULT false,
        PRIMARY KEY(user_id, project_id, source_id, message_id),
        FOREIGN KEY(user_id, project_id, source_id) REFERENCES memory_sources ON DELETE CASCADE,
        CHECK (deleted OR (content_hash IS NOT NULL AND role IS NOT NULL AND occurred_at IS NOT NULL)))""")
    # No old batch identity can reliably prove a caller's dialogId. Keep a clearly
    # marked legacy group per old blob, including receipts without committed blobs.
    legacy_ids = {}
    for row in db.execute(text("SELECT * FROM memory_blobs")).mappings().all():
        sid = "legacy:" + str(row["id"])
        legacy_ids.setdefault((row["user_id"], row["project_id"]), set()).add(str(row["id"]))
        args = {"uid": row["user_id"], "pid": row["project_id"], "sid": sid}
        db.execute(text("INSERT INTO memory_sources(user_id,project_id,source_id,legacy,created_at) VALUES (:uid,:pid,:sid,true,:created)"),
                   {**args, "created": row["created_at"]})
        mids = []
        for message in row["payload"]["messages"]:
            mids.append(message["message_id"])
            when = datetime.fromisoformat(message["occurred_at"])
            digest = _hash({"role": message["role"], "content": message["content"],
                            "occurred_at": when.astimezone(timezone.utc).isoformat()})
            db.execute(text("""INSERT INTO memory_messages(user_id,project_id,source_id,message_id,content_hash,role,occurred_at,processed,deleted)
                VALUES (:uid,:pid,:sid,:mid,:digest,:role,:when,true,:deleted)"""),
                {**args, "mid": message["message_id"], "digest": digest, "role": message["role"],
                 "when": when, "deleted": message["message_id"] in row["retracted_message_ids"]})
        db.execute(text("UPDATE memory_blobs SET source_id=:sid,message_ids=CAST(:mids AS jsonb) WHERE id=:id"),
                   {"sid": sid, "id": row["id"], "mids": json.dumps(mids)})
    for row in db.execute(text("SELECT * FROM memory_operations")).mappings().all():
        sid = "legacy:" + str(row["blob_id"] or row["id"])
        db.execute(text("INSERT INTO memory_sources(user_id,project_id,source_id,legacy) VALUES (:uid,:pid,:sid,true) ON CONFLICT DO NOTHING"),
                   {"uid": row["user_id"], "pid": row["project_id"], "sid": sid})
        body = dict(row["request"])
        body.pop("external_id", None)
        body["source_id"] = sid
        blob_id = row["blob_id"]
        if row["kind"] == "import" and blob_id is None:
            blob_id = row["id"]
            for message in body["messages"]:
                when = datetime.fromisoformat(message["occurred_at"])
                digest = _hash({"role": message["role"], "content": message["content"],
                                "occurred_at": when.astimezone(timezone.utc).isoformat()})
                db.execute(text("""INSERT INTO memory_messages(user_id,project_id,source_id,message_id,content_hash,role,occurred_at)
                    VALUES (:uid,:pid,:sid,:mid,:digest,:role,:when)"""),
                    {"uid": row["user_id"], "pid": row["project_id"], "sid": sid, "mid": message["message_id"],
                     "digest": digest, "role": message["role"], "when": when})
            db.execute(text("""INSERT INTO memory_blobs(id,user_id,project_id,external_id,payload,request_hash,status,source_id,message_ids)
                VALUES (:id,:uid,:pid,:external,CAST(:body AS jsonb),:digest,'active',:sid,CAST(:mids AS jsonb))"""),
                {"id": blob_id, "uid": row["user_id"], "pid": row["project_id"], "external": row["external_id"],
                 "body": json.dumps(body), "digest": row["request_hash"], "sid": sid,
                 "mids": json.dumps([m["message_id"] for m in body["messages"]])})
        # Preserve incomplete input only; completed receipts are the recovery source.
        accepted_hash = _hash({"kind": row["kind"], "request": {k: v for k, v in body.items() if k != "reconcile_topics"}})
        if row["kind"] == "import" and row["status"] == "completed":
            body = {"source_id": sid, "idempotency_key": row["idempotency_key"]}
        db.execute(text("""UPDATE memory_operations SET source_id=:sid,request=CAST(:body AS jsonb),request_hash=:digest,
            blob_id=:blob_id,input_expires_at=CASE WHEN kind='import' AND status!='completed' THEN now()+interval '7 days' ELSE NULL END WHERE id=:id"""),
            {"sid": sid, "body": json.dumps(body), "digest": accepted_hash, "blob_id": blob_id, "id": row["id"]})
    # Convert only lineage identifiers; do not regenerate business memory.
    op.execute("ALTER TABLE memory_profile_revisions ALTER COLUMN source_id TYPE VARCHAR(255) USING 'legacy:' || source_id::text")
    for table, field in [("user_profiles", "attributes"), ("user_events", "event_data"), ("user_event_gists", "gist_data")]:
        # Table names are constants; JSON remains parameterized, including stored text.
        for row in db.execute(text(f"SELECT id,user_id,project_id,{field} AS value FROM {table}")).mappings().all():
            known = legacy_ids.get((row["user_id"], row["project_id"]), set())
            value = dict(row["value"] or {})
            changed = False
            if "source_ids" in value:
                replaced = ["legacy:" + item if item in known else item for item in value["source_ids"]]
                changed = replaced != value["source_ids"]
                value["source_ids"] = replaced
            if value.get("source_id") in known:
                value["blob_id"] = value["source_id"]
                value["source_id"] = "legacy:" + value["source_id"]
                changed = True
            if changed:
                db.execute(text(f"UPDATE {table} SET {field}=CAST(:value AS jsonb) WHERE id=:id AND project_id=:pid"),
                           {"value": json.dumps(value), "id": row["id"], "pid": row["project_id"]})
    for row in db.execute(text("SELECT id,user_id,project_id,profiles,added,removed FROM memory_profile_revisions")).mappings().all():
        known = legacy_ids.get((row["user_id"], row["project_id"]), set())
        values = {}
        for field in ("profiles", "added", "removed"):
            values[field] = json.dumps([{**p, "source_ids": ["legacy:" + item if item in known else item
                                                             for item in p["source_ids"]]} for p in row[field]])
        db.execute(text("UPDATE memory_profile_revisions SET profiles=CAST(:profiles AS jsonb),added=CAST(:added AS jsonb),removed=CAST(:removed AS jsonb) WHERE id=:id"),
                   {**values, "id": row["id"]})
    op.execute("ALTER TABLE memory_blobs DROP COLUMN payload, DROP COLUMN request_hash, DROP COLUMN external_id, DROP COLUMN retracted_message_ids")
    op.execute("ALTER TABLE memory_operations DROP COLUMN external_id")
    op.execute("ALTER TABLE memory_blobs ALTER COLUMN source_id SET NOT NULL, ALTER COLUMN message_ids SET NOT NULL, ADD UNIQUE(id,user_id,project_id), ADD UNIQUE(id,user_id,project_id,source_id)")
    op.execute("ALTER TABLE memory_operations ALTER COLUMN source_id SET NOT NULL, ADD UNIQUE(id,user_id,project_id), ADD UNIQUE(id,user_id,project_id,source_id)")
    op.execute("ALTER TABLE memory_operations DROP CONSTRAINT memory_operations_completion_check")
    op.execute("""ALTER TABLE memory_operations ADD CONSTRAINT memory_operations_completion_check CHECK (
        (status!='completed' OR (result IS NOT NULL AND error IS NULL AND (kind!='import' OR blob_id IS NOT NULL)))
        AND (status!='failed' OR error IS NOT NULL))""")
    for table in ("memory_blobs", "memory_operations", "memory_profile_revisions"):
        op.execute(f"ALTER TABLE {table} ADD FOREIGN KEY(user_id,project_id,source_id) REFERENCES memory_sources ON DELETE CASCADE")
    for table in ("memory_facts", "memory_operations"):
        op.execute(f"ALTER TABLE {table} ADD FOREIGN KEY(blob_id,user_id,project_id) REFERENCES memory_blobs(id,user_id,project_id) ON DELETE CASCADE")
    op.execute("ALTER TABLE memory_operations ADD FOREIGN KEY(blob_id,user_id,project_id,source_id) REFERENCES memory_blobs(id,user_id,project_id,source_id) ON DELETE CASCADE")
    op.execute("ALTER TABLE memory_profile_revisions ADD FOREIGN KEY(operation_id,user_id,project_id,source_id) REFERENCES memory_operations(id,user_id,project_id,source_id) ON DELETE CASCADE")
    op.execute("CREATE INDEX idx_memory_blobs_group ON memory_blobs(user_id,project_id,source_id,created_at,id)")
    op.execute("CREATE UNIQUE INDEX uq_memory_import_blob ON memory_operations(blob_id) WHERE kind='import'")
    # JSON groups are the single evidence representation. A database constraint
    # trigger validates every member against the same owner/source/message ledger,
    # avoiding a second writable copy of this graph in a junction table.
    op.execute("""CREATE FUNCTION check_memory_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE current_fact memory_facts; batch memory_blobs; group_ids jsonb; mid text; seen jsonb := '[]'; canonical jsonb;
    BEGIN
        SELECT * INTO current_fact FROM memory_facts WHERE id=NEW.id;
        IF NOT FOUND THEN RETURN NULL; END IF;
        SELECT * INTO batch FROM memory_blobs WHERE id=current_fact.blob_id
            AND user_id=current_fact.user_id AND project_id=current_fact.project_id;
        IF NOT FOUND OR jsonb_typeof(current_fact.support_groups)!='array'
            OR jsonb_array_length(current_fact.support_groups)=0 THEN RAISE EXCEPTION 'invalid fact support' USING ERRCODE='23514'; END IF;
        FOR group_ids IN SELECT value FROM jsonb_array_elements(current_fact.support_groups) LOOP
            IF jsonb_typeof(group_ids)!='array' OR jsonb_array_length(group_ids)=0 THEN
                RAISE EXCEPTION 'empty support group' USING ERRCODE='23514'; END IF;
            IF EXISTS(SELECT 1 FROM jsonb_array_elements(group_ids) v WHERE jsonb_typeof(v)!='string')
                OR jsonb_array_length(group_ids)!=(SELECT count(DISTINCT value) FROM jsonb_array_elements_text(group_ids)) THEN
                RAISE EXCEPTION 'invalid support members' USING ERRCODE='23514'; END IF;
            SELECT jsonb_agg(value ORDER BY value) INTO canonical FROM jsonb_array_elements_text(group_ids);
            IF EXISTS(SELECT 1 FROM jsonb_array_elements(seen) v WHERE v=canonical) THEN
                RAISE EXCEPTION 'duplicate independent support group' USING ERRCODE='23514'; END IF;
            seen := seen || jsonb_build_array(canonical);
            FOR mid IN SELECT jsonb_array_elements_text(group_ids) LOOP
                IF NOT batch.message_ids ? mid OR NOT EXISTS (SELECT 1 FROM memory_messages
                    WHERE user_id=batch.user_id AND project_id=batch.project_id AND source_id=batch.source_id
                        AND message_id=mid AND NOT deleted) THEN
                    RAISE EXCEPTION 'support outside active source messages' USING ERRCODE='23514'; END IF;
            END LOOP;
        END LOOP;
        RETURN NULL;
    END $$""")
    op.execute("CREATE CONSTRAINT TRIGGER memory_evidence_owner AFTER INSERT OR UPDATE ON memory_facts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_memory_evidence()")
    op.execute("""CREATE FUNCTION check_memory_blob_messages() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE batch memory_blobs; mid text;
    BEGIN
        SELECT * INTO batch FROM memory_blobs WHERE id=NEW.id;
        IF NOT FOUND THEN RETURN NULL; END IF;
        IF jsonb_typeof(batch.message_ids)!='array' OR jsonb_array_length(batch.message_ids)=0
            OR EXISTS(SELECT 1 FROM jsonb_array_elements(batch.message_ids) v WHERE jsonb_typeof(v)!='string')
            OR jsonb_array_length(batch.message_ids)!=(SELECT count(DISTINCT value) FROM jsonb_array_elements_text(batch.message_ids)) THEN
            RAISE EXCEPTION 'invalid blob messages' USING ERRCODE='23514'; END IF;
        FOR mid IN SELECT jsonb_array_elements_text(batch.message_ids) LOOP
            IF NOT EXISTS(SELECT 1 FROM memory_messages WHERE user_id=batch.user_id AND project_id=batch.project_id
                AND source_id=batch.source_id AND message_id=mid) THEN
                RAISE EXCEPTION 'blob message outside source' USING ERRCODE='23514'; END IF;
        END LOOP;
        IF EXISTS(SELECT 1 FROM memory_facts WHERE blob_id=batch.id AND
            EXISTS(SELECT 1 FROM jsonb_array_elements(support_groups) g,
                LATERAL jsonb_array_elements_text(g) m WHERE NOT batch.message_ids ? m)) THEN
            RAISE EXCEPTION 'blob still owns excluded evidence' USING ERRCODE='23514'; END IF;
        RETURN NULL;
    END $$""")
    op.execute("CREATE CONSTRAINT TRIGGER memory_blob_message_owner AFTER INSERT OR UPDATE ON memory_blobs DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_memory_blob_messages()")
    op.execute("""CREATE FUNCTION guard_memory_message_identity() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
        IF ROW(NEW.user_id,NEW.project_id,NEW.source_id,NEW.message_id,NEW.content_hash,NEW.role,NEW.occurred_at)
            IS DISTINCT FROM ROW(OLD.user_id,OLD.project_id,OLD.source_id,OLD.message_id,OLD.content_hash,OLD.role,OLD.occurred_at)
            OR (OLD.deleted AND NOT NEW.deleted) OR (OLD.processed AND NOT NEW.processed) THEN
            RAISE EXCEPTION 'message identity is immutable' USING ERRCODE='23514'; END IF;
        RETURN NEW;
    END $$""")
    op.execute("CREATE TRIGGER memory_message_identity BEFORE UPDATE ON memory_messages FOR EACH ROW EXECUTE FUNCTION guard_memory_message_identity()")
    op.execute("""CREATE FUNCTION check_memory_message_delete() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
        IF EXISTS(SELECT 1 FROM memory_messages WHERE user_id=OLD.user_id AND project_id=OLD.project_id
            AND source_id=OLD.source_id AND message_id=OLD.message_id AND NOT deleted) THEN RETURN NULL; END IF;
        IF EXISTS(SELECT 1 FROM memory_facts f JOIN memory_blobs b ON b.id=f.blob_id
            WHERE b.user_id=OLD.user_id AND b.project_id=OLD.project_id AND b.source_id=OLD.source_id
                AND EXISTS(SELECT 1 FROM jsonb_array_elements(f.support_groups) g WHERE g ? OLD.message_id)) THEN
            RAISE EXCEPTION 'message still supports facts' USING ERRCODE='23514'; END IF;
        IF NOT EXISTS(SELECT 1 FROM memory_messages WHERE user_id=OLD.user_id AND project_id=OLD.project_id
            AND source_id=OLD.source_id AND message_id=OLD.message_id) AND EXISTS(SELECT 1 FROM memory_blobs
            WHERE user_id=OLD.user_id AND project_id=OLD.project_id AND source_id=OLD.source_id AND message_ids ? OLD.message_id) THEN
            RAISE EXCEPTION 'message still belongs to a blob' USING ERRCODE='23514'; END IF;
        RETURN NULL;
    END $$""")
    op.execute("CREATE CONSTRAINT TRIGGER memory_message_support AFTER UPDATE OR DELETE ON memory_messages DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_memory_message_delete()")
    # Validate the adopted graph before dropping its only legacy input copies.
    op.execute("UPDATE memory_facts SET included=included")
    op.execute("UPDATE memory_blobs SET status=status")
    # Only old chat blobs with no unfinished buffer dependency may be scrubbed.
    op.execute("""DELETE FROM general_blobs g WHERE g.blob_type='chat' AND
        EXISTS(SELECT 1 FROM buffer_zones b WHERE b.blob_id=g.id AND b.project_id=g.project_id AND b.status='done') AND
        NOT EXISTS(SELECT 1 FROM buffer_zones b WHERE b.blob_id=g.id AND b.project_id=g.project_id AND b.status!='done')""")
    op.execute("COMMENT ON TABLE memory_sources IS '外部来源分组，不保存聊天正文；legacy 标明无法还原的旧批次来源'")
    op.execute("COMMENT ON TABLE memory_messages IS '来源内稳定消息身份、正文指纹与删除标记；不保存正文'")
    for table, columns in {
        "memory_sources": {"user_id": "来源所属用户", "project_id": "鉴权确定的项目", "source_id": "调用方来源分组身份", "legacy": "无法还原真实来源的旧协议边界", "created_at": "来源首次登记时间"},
        "memory_messages": {"user_id": "消息所属用户", "project_id": "消息所属项目", "source_id": "消息所属来源", "message_id": "来源内稳定外部消息身份", "content_hash": "正文角色时间的不可变指纹，不保存正文", "role": "消息角色", "occurred_at": "消息实际发生时间", "processed": "是否已成功参与处理", "deleted": "永久删除贡献标记"},
        "memory_blobs": {"source_id": "本批输入所属来源", "message_ids": "本批固定消息身份清单"},
        "memory_operations": {"source_id": "操作所属外部来源", "blob_id": "导入操作的一一对应批次身份", "input_expires_at": "未完成输入临时保留截止时间，不随恢复续期"},
        "memory_facts": {"blob_id": "抽取此事实的输入批次"},
        "memory_profile_revisions": {"source_id": "本次变化所属来源"},
    }.items():
        for column, description in columns.items():
            op.execute(f"COMMENT ON COLUMN {table}.{column} IS '{description}'")


def downgrade():
    raise RuntimeError("Source grouping and input erasure require a compatible forward release")
