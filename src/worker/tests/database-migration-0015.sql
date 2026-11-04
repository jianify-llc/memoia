-- Original 0015 trigger implementations, retained from revision 0006.
SET search_path TO memoia,extensions,public;
CREATE OR REPLACE FUNCTION check_memory_blob_messages() RETURNS trigger LANGUAGE plpgsql AS $$
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
    END $$;
CREATE OR REPLACE FUNCTION check_memory_message_delete() RETURNS trigger LANGUAGE plpgsql AS $$
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
    END $$;
ALTER TABLE memory_facts ADD CONSTRAINT memory_facts_source_id_fkey FOREIGN KEY (blob_id) REFERENCES memory_blobs(id);
UPDATE alembic_version SET version_num='0015_event_time';
