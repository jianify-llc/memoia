CREATE OR REPLACE FUNCTION memoia.check_memory_blob_flush() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
        DECLARE batch memoia.memory_blobs;
        BEGIN
          SELECT * INTO batch FROM memoia.memory_blobs WHERE id=NEW.id;
          IF NOT FOUND OR batch.flush_operation_id IS NULL THEN RETURN NULL; END IF;
          IF batch.fact_completed_at IS NULL OR NOT EXISTS(
            SELECT 1 FROM memoia.memory_operations o WHERE o.id=batch.flush_operation_id
              AND o.user_id=batch.user_id AND o.project_id=batch.project_id AND o.kind='flush') THEN
            RAISE EXCEPTION 'invalid flush batch owner or lifecycle' USING ERRCODE='23514';
          END IF;
          RETURN NULL;
        END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION memoia.check_memory_evidence() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    DECLARE current_fact memoia.memory_facts; batch memoia.memory_blobs; group_ids jsonb; mid text; seen jsonb := '[]'; canonical jsonb;
    BEGIN
        SELECT * INTO current_fact FROM memoia.memory_facts WHERE id=NEW.id;
        IF NOT FOUND THEN RETURN NULL; END IF;
        SELECT * INTO batch FROM memoia.memory_blobs WHERE id=current_fact.blob_id
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
                IF NOT batch.message_ids ? mid OR NOT EXISTS (SELECT 1 FROM memoia.memory_messages
                    WHERE user_id=batch.user_id AND project_id=batch.project_id AND source_id=batch.source_id
                        AND message_id=mid AND NOT deleted) THEN
                    RAISE EXCEPTION 'support outside active source messages' USING ERRCODE='23514'; END IF;
            END LOOP;
        END LOOP;
        RETURN NULL;
    END $$;
