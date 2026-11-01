"""Keep evidence checks local and skip them after their Source has cascaded away."""
from alembic import op

revision = "0016_source_cascade"
down_revision = "0015_event_time"
branch_labels = None
depends_on = None


def upgrade():
    # 0006 added the owner-scoped FK after renaming source_id to blob_id. The
    # original single-column FK duplicates it and scans Facts once per old Blob.
    op.drop_constraint("memory_facts_source_id_fkey", "memory_facts", type_="foreignkey")
    op.execute("""CREATE OR REPLACE FUNCTION check_memory_message_delete() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
        IF EXISTS(SELECT 1 FROM memory_messages WHERE user_id=OLD.user_id AND project_id=OLD.project_id
            AND source_id=OLD.source_id AND message_id=OLD.message_id AND NOT deleted) THEN RETURN NULL; END IF;
        -- Source FKs have already removed the whole graph; deferred row checks
        -- must not rescan the former Source once for every deleted message.
        IF NOT EXISTS(SELECT 1 FROM memory_sources WHERE user_id=OLD.user_id AND project_id=OLD.project_id
            AND source_id=OLD.source_id) THEN RETURN NULL; END IF;
        IF EXISTS(SELECT 1 FROM memory_blobs b JOIN memory_facts f
            ON f.blob_id=b.id AND f.user_id=b.user_id AND f.project_id=b.project_id
            WHERE b.user_id=OLD.user_id AND b.project_id=OLD.project_id AND b.source_id=OLD.source_id
                AND b.message_ids ? OLD.message_id
                AND EXISTS(SELECT 1 FROM jsonb_array_elements(f.support_groups) g WHERE g ? OLD.message_id)) THEN
            RAISE EXCEPTION 'message still supports facts' USING ERRCODE='23514'; END IF;
        IF NOT EXISTS(SELECT 1 FROM memory_messages WHERE user_id=OLD.user_id AND project_id=OLD.project_id
            AND source_id=OLD.source_id AND message_id=OLD.message_id) AND EXISTS(SELECT 1 FROM memory_blobs
            WHERE user_id=OLD.user_id AND project_id=OLD.project_id AND source_id=OLD.source_id AND message_ids ? OLD.message_id) THEN
            RAISE EXCEPTION 'message still belongs to a blob' USING ERRCODE='23514'; END IF;
        RETURN NULL;
    END $$""")
    op.execute("""CREATE OR REPLACE FUNCTION check_memory_blob_messages() RETURNS trigger LANGUAGE plpgsql AS $$
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
        IF EXISTS(SELECT 1 FROM memory_facts WHERE blob_id=batch.id AND user_id=batch.user_id
            AND project_id=batch.project_id AND EXISTS(SELECT 1 FROM jsonb_array_elements(support_groups) g,
                LATERAL jsonb_array_elements_text(g) m WHERE NOT batch.message_ids ? m)) THEN
            RAISE EXCEPTION 'blob still owns excluded evidence' USING ERRCODE='23514'; END IF;
        RETURN NULL;
    END $$""")


def downgrade():
    raise RuntimeError("Source cascade checks require a forward migration")
