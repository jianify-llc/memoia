"""Retire automatic corrections; keep supported historical statements."""
import hashlib
import json
from uuid import uuid4

from alembic import op
from sqlalchemy import text

revision = "0010_historical_facts"
down_revision = "0009_blob_flush"
branch_labels = None
depends_on = None


def upgrade():
    db = op.get_bind()
    # Preserve deletion navigation before cascades remove relational evidence.
    op.execute("""
        CREATE TEMP TABLE retired_facts ON COMMIT DROP AS
          SELECT id,user_id,project_id FROM memory_facts WHERE NOT active;
        CREATE UNIQUE INDEX ON retired_facts(user_id,project_id,id);
        UPDATE user_events e SET event_data=jsonb_set(COALESCE(e.event_data,'{}'),'{fact_ids}',
          (SELECT jsonb_agg(DISTINCT ids.id ORDER BY ids.id) FROM (
            SELECT jsonb_array_elements_text(COALESCE(e.event_data->'fact_ids','[]')) AS id
            UNION SELECT ef.fact_id::text FROM memory_event_facts ef
              WHERE ef.event_id=e.id AND ef.user_id=e.user_id AND ef.project_id=e.project_id
          ) ids))
        WHERE EXISTS(SELECT 1 FROM memory_event_facts ef JOIN retired_facts r
          ON r.id=ef.fact_id AND r.user_id=ef.user_id AND r.project_id=ef.project_id
          WHERE ef.event_id=e.id AND ef.user_id=e.user_id AND ef.project_id=e.project_id);
    """)
    for column in ("profiles", "added", "removed"):
        op.execute(f"""UPDATE memory_profile_revisions h SET {column}=(
          SELECT COALESCE(jsonb_agg(entry ORDER BY position),'[]')
          FROM jsonb_array_elements(h.{column}) WITH ORDINALITY AS items(entry,position)
          WHERE NOT EXISTS(SELECT 1 FROM retired_facts r
            WHERE r.user_id=h.user_id AND r.project_id=h.project_id AND entry->'fact_ids' ? r.id::text))
          WHERE EXISTS(SELECT 1 FROM retired_facts r WHERE r.user_id=h.user_id AND r.project_id=h.project_id
            AND EXISTS(SELECT 1 FROM jsonb_array_elements(h.{column}) entry WHERE entry->'fact_ids' ? r.id::text))""")

    owners = db.execute(text("SELECT DISTINCT user_id,project_id FROM retired_facts ORDER BY project_id,user_id")).all()
    for uid, pid in owners:
        version = db.execute(text("""INSERT INTO memory_user_states(user_id,project_id,version)
          VALUES(:uid,:pid,1) ON CONFLICT(user_id,project_id) DO UPDATE
          SET version=memory_user_states.version+1 RETURNING version"""), dict(uid=uid, pid=pid)).scalar_one()
        after = None
        while True:
            # 1,000 UUID-only changes stay below the existing 256 KiB flush budget.
            ids = db.execute(text("""SELECT id FROM retired_facts WHERE user_id=:uid AND project_id=:pid
              AND (CAST(:after AS uuid) IS NULL OR id>CAST(:after AS uuid)) ORDER BY id LIMIT 1000"""),
              dict(uid=uid, pid=pid, after=after)).scalars().all()
            if not ids:
                break
            ident = uuid4()
            request = json.dumps(dict(blob_ids=[], legacy_changes=[
                dict(kind="deleted", fact_id=str(fid), version=version) for fid in ids]))
            db.execute(text("""INSERT INTO memory_operations(id,user_id,project_id,idempotency_key,
              kind,request_hash,request,status,generation,available_at) VALUES(:id,:uid,:pid,:key,
              'flush',:hash,CAST(:request AS jsonb),'processing',0,now())"""),
              dict(id=ident, uid=uid, pid=pid, key=f"historical-facts:{ident}",
                   hash=hashlib.sha256(request.encode()).hexdigest(), request=request))
            after = ids[-1]

    op.execute("""
        DROP TRIGGER memory_correction_evidence ON memory_fact_corrections;
        DROP TRIGGER memory_correction_origin_evidence ON memory_facts;
        DROP TRIGGER memory_correction_message_evidence ON memory_messages;
        DROP TRIGGER memory_correction_blob_evidence ON memory_blobs;
        DROP FUNCTION check_memory_correction_support();
        DROP FUNCTION validate_memory_correction_support(UUID,UUID,VARCHAR);
        DROP TABLE memory_fact_corrections;
        DELETE FROM memory_facts f USING retired_facts r
          WHERE f.id=r.id AND f.user_id=r.user_id AND f.project_id=r.project_id;
        SET CONSTRAINTS ALL IMMEDIATE;
        SET CONSTRAINTS ALL DEFERRED;
        DROP INDEX idx_memory_facts_lexical;
        ALTER TABLE memory_facts DROP COLUMN active;
        CREATE INDEX idx_memory_facts_lexical ON memory_facts USING gin(
          to_tsvector('simple',COALESCE(search_text,content)));
        CREATE INDEX idx_memory_event_facts_reverse ON memory_event_facts(user_id,project_id,fact_id);
    """)


def downgrade():
    raise RuntimeError("Retired hidden facts cannot be restored; use a forward migration")
