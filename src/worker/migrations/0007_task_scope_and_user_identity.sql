-- Legato owns execution. Unique constraints arbitrate competing claims and active Blob ranges.
UPDATE memoia.queue_tasks t
SET user_id=o.user_id,
    biz_params=t.biz_params || jsonb_build_object('project_id',o.project_id,'blob_id',o.blob_id)
FROM memoia.memory_operations o
WHERE o.id=t.id AND t.type IN ('fact_flush','maintenance_flush');
--> statement-breakpoint
CREATE UNIQUE INDEX uq_memoia_running_task_scope
ON memoia.queue_tasks (user_id,(biz_params->>'project_id'),type)
WHERE status='running' AND type IN ('fact_flush','maintenance_flush');
--> statement-breakpoint
CREATE UNIQUE INDEX uq_memoia_active_fact_blob
ON memoia.queue_tasks ((biz_params->>'blob_id'))
WHERE type='fact_flush' AND status IN ('pending','queued','running','retry_wait');
--> statement-breakpoint
-- Forgetting takes the same users unique key before recording the tombstone.
-- An insert that waited behind a forget sees the tombstone when this trigger runs.
CREATE FUNCTION memoia.reject_forgotten_user() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM memoia.memory_user_tombstones
             WHERE project_id=NEW.project_id AND user_id=NEW.id) THEN
    RAISE EXCEPTION 'User identity was permanently forgotten'
      USING ERRCODE='23514', CONSTRAINT='memoia_user_forgotten';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER reject_forgotten_user AFTER INSERT ON memoia.users
FOR EACH ROW EXECUTE FUNCTION memoia.reject_forgotten_user();

--> statement-breakpoint
-- Blob membership is retained as history after a message is removed.
CREATE OR REPLACE FUNCTION memoia.check_memory_blob_messages() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    DECLARE batch memoia.memory_blobs; mid text;
    BEGIN
        SELECT * INTO batch FROM memoia.memory_blobs WHERE id=NEW.id;
        IF NOT FOUND THEN RETURN NULL; END IF;
        IF jsonb_typeof(batch.message_ids)!='array' OR jsonb_array_length(batch.message_ids)=0
            OR EXISTS(SELECT 1 FROM jsonb_array_elements(batch.message_ids) v WHERE jsonb_typeof(v)!='string')
            OR jsonb_array_length(batch.message_ids)!=(SELECT count(DISTINCT value) FROM jsonb_array_elements_text(batch.message_ids)) THEN
            RAISE EXCEPTION 'invalid blob messages' USING ERRCODE='23514'; END IF;
        FOR mid IN SELECT jsonb_array_elements_text(batch.message_ids) LOOP
            IF batch.kind='import' AND (TG_OP='INSERT' OR NOT OLD.message_ids ? mid)
               AND NOT EXISTS(SELECT 1 FROM memoia.memory_messages WHERE user_id=batch.user_id AND project_id=batch.project_id
                AND source_id=batch.source_id AND message_id=mid) THEN
                RAISE EXCEPTION 'blob message outside source' USING ERRCODE='23514'; END IF;
        END LOOP;
        IF EXISTS(SELECT 1 FROM memoia.memory_facts WHERE blob_id=batch.id AND user_id=batch.user_id
            AND project_id=batch.project_id AND EXISTS(SELECT 1 FROM jsonb_array_elements(support_groups) g,
                LATERAL jsonb_array_elements_text(g) m WHERE NOT batch.message_ids ? m)) THEN
            RAISE EXCEPTION 'blob still owns excluded evidence' USING ERRCODE='23514'; END IF;
        RETURN NULL;
    END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION memoia.check_memory_message_delete() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
        IF EXISTS(SELECT 1 FROM memoia.memory_messages WHERE user_id=OLD.user_id AND project_id=OLD.project_id
            AND source_id=OLD.source_id AND message_id=OLD.message_id AND NOT deleted) THEN RETURN NULL; END IF;
        -- Source FKs have already removed the whole graph; deferred row checks
        -- must not rescan the former Source once for every deleted message.
        IF NOT EXISTS(SELECT 1 FROM memoia.memory_sources WHERE user_id=OLD.user_id AND project_id=OLD.project_id
            AND source_id=OLD.source_id) THEN RETURN NULL; END IF;
        IF EXISTS(SELECT 1 FROM memoia.memory_blobs b JOIN memoia.memory_facts f
            ON f.blob_id=b.id AND f.user_id=b.user_id AND f.project_id=b.project_id
            WHERE b.user_id=OLD.user_id AND b.project_id=OLD.project_id AND b.source_id=OLD.source_id
                AND b.message_ids ? OLD.message_id
                AND EXISTS(SELECT 1 FROM jsonb_array_elements(f.support_groups) g WHERE g ? OLD.message_id)) THEN
            RAISE EXCEPTION 'message still supports facts' USING ERRCODE='23514'; END IF;
        RETURN NULL;
    END $$;
