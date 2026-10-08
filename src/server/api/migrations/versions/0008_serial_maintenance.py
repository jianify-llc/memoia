"""Fact-owned retrieval and fenced, serial derived maintenance."""
from alembic import op

revision = "0008_serial_maintenance"
down_revision = "0007_event_time_evidence"
branch_labels = None
depends_on = None


def upgrade():
    op.execute("""
        ALTER TABLE memory_facts
          ALTER COLUMN topic DROP NOT NULL, ALTER COLUMN sub_topic DROP NOT NULL,
          ADD COLUMN subject VARCHAR(512), ADD COLUMN reporter VARCHAR(512),
          ADD COLUMN certainty VARCHAR(16) NOT NULL DEFAULT 'legacy',
          ADD COLUMN active BOOLEAN NOT NULL DEFAULT true,
          ADD COLUMN revision BIGINT NOT NULL DEFAULT 1,
          ADD COLUMN created_version BIGINT NOT NULL DEFAULT 0,
          ADD COLUMN search_text TEXT,
          ADD CONSTRAINT uq_memory_facts_owner UNIQUE (id,user_id,project_id),
          ADD CONSTRAINT ck_memory_facts_revision CHECK (revision > 0 AND created_version >= 0),
          ADD CONSTRAINT ck_memory_facts_certainty CHECK (certainty IN ('legacy','asserted','reported','uncertain'));
        ALTER TABLE user_profiles ADD COLUMN revision BIGINT NOT NULL DEFAULT 1;
        ALTER TABLE user_events ADD COLUMN revision BIGINT NOT NULL DEFAULT 1,
          ADD CONSTRAINT uq_user_events_owner UNIQUE (id,user_id,project_id);
        DO $$ DECLARE dimension INTEGER; BEGIN
          SELECT atttypmod INTO dimension FROM pg_attribute
            WHERE attrelid='user_events'::regclass AND attname='embedding';
          EXECUTE format('ALTER TABLE memory_facts ADD COLUMN embedding vector(%s)',dimension);
        END $$;
        UPDATE memory_facts f SET search_text=COALESCE((
          SELECT COALESCE(g.gist_data->>'search_text',g.gist_data->>'content')
          FROM user_event_gists g WHERE g.user_id=f.user_id AND g.project_id=f.project_id
            AND g.gist_data->>'fact_id'=f.id::text ORDER BY g.id LIMIT 1), f.content);
        UPDATE memory_facts f SET embedding=g.embedding FROM user_event_gists g
          WHERE g.user_id=f.user_id AND g.project_id=f.project_id AND g.gist_data->>'fact_id'=f.id::text;
        SET CONSTRAINTS ALL IMMEDIATE;
        CREATE INDEX idx_memory_facts_lexical ON memory_facts USING gin(to_tsvector('simple',COALESCE(search_text,content))) WHERE active;
        COMMENT ON COLUMN memory_facts.subject IS '事实被断言的主体；旧事实未知，不推测回填';
        COMMENT ON COLUMN memory_facts.reporter IS '陈述报告者，不等同于事实主体';
        COMMENT ON COLUMN memory_facts.certainty IS '断言、转述、不确定或历史未知，不将推测升级为确定事实';
        COMMENT ON COLUMN memory_facts.active IS '当前有效性，与仅控制历史画像纳入的 included 独立';
        COMMENT ON COLUMN memory_facts.revision IS '事实正文、证据、时间或有效性改变时递增的提交校验版本';
        COMMENT ON COLUMN memory_facts.created_version IS '首次保存的用户记忆水位，阻止维护轮次吞掉后续新增事实';
        COMMENT ON COLUMN memory_facts.search_text IS '从事实及发生时间派生的检索文本，不依赖 Event';
        COMMENT ON COLUMN memory_facts.embedding IS '直接关联事实的检索向量';
        COMMENT ON COLUMN user_profiles.revision IS '画像修改版本，防止维护阶段覆盖并发编辑';
        COMMENT ON COLUMN user_events.revision IS '事件修改版本，防止维护阶段覆盖并发编辑';
    """)
    op.execute("""
        CREATE TABLE memory_fact_corrections (
          user_id UUID NOT NULL, project_id VARCHAR(64) NOT NULL,
          fact_id UUID NOT NULL, corrected_fact_id UUID NOT NULL, support_groups JSONB NOT NULL,
          PRIMARY KEY(fact_id,corrected_fact_id,project_id), CHECK(fact_id <> corrected_fact_id),
          FOREIGN KEY(fact_id,user_id,project_id) REFERENCES memory_facts(id,user_id,project_id) ON DELETE CASCADE,
          FOREIGN KEY(corrected_fact_id,user_id,project_id) REFERENCES memory_facts(id,user_id,project_id) ON DELETE CASCADE);
        CREATE TABLE memory_event_facts (
          user_id UUID NOT NULL, project_id VARCHAR(64) NOT NULL,
          event_id UUID NOT NULL, fact_id UUID NOT NULL,
          PRIMARY KEY(event_id,fact_id,project_id),
          FOREIGN KEY(event_id,user_id,project_id) REFERENCES user_events(id,user_id,project_id) ON DELETE CASCADE,
          FOREIGN KEY(fact_id,user_id,project_id) REFERENCES memory_facts(id,user_id,project_id) ON DELETE CASCADE);
        INSERT INTO memory_event_facts(user_id,project_id,event_id,fact_id)
          SELECT f.user_id,f.project_id,b.event_id,f.id FROM memory_facts f
          JOIN memory_blobs b ON (b.id,b.user_id,b.project_id)=(f.blob_id,f.user_id,f.project_id)
          JOIN user_events e ON (e.id,e.user_id,e.project_id)=(b.event_id,b.user_id,b.project_id)
          ON CONFLICT DO NOTHING;
        CREATE TABLE memory_deleted_events (
          user_id UUID NOT NULL, project_id VARCHAR(64) NOT NULL, id UUID NOT NULL,
          PRIMARY KEY(id,user_id,project_id),
          FOREIGN KEY(user_id,project_id) REFERENCES users(id,project_id) ON DELETE CASCADE);
        ALTER TABLE memory_profile_revisions ALTER COLUMN operation_id DROP NOT NULL,
          ALTER COLUMN source_id DROP NOT NULL, ADD COLUMN maintenance_version BIGINT,
          ADD CONSTRAINT uq_profile_maintenance UNIQUE(user_id,project_id,maintenance_version);
        COMMENT ON TABLE memory_fact_corrections IS '有证据的明确纠正关系；两个端点严格属于同一用户及项目';
        COMMENT ON COLUMN memory_fact_corrections.user_id IS '纠正双方所属用户';
        COMMENT ON COLUMN memory_fact_corrections.project_id IS '纠正双方所属鉴权项目';
        COMMENT ON COLUMN memory_fact_corrections.fact_id IS '提供明确纠正的事实';
        COMMENT ON COLUMN memory_fact_corrections.corrected_fact_id IS '被明确纠正的历史事实，非普通时间变化';
        COMMENT ON COLUMN memory_fact_corrections.support_groups IS '支持明确纠正关系本身的消息组，不把对新值的普通确认当成历史纠错证据';
        COMMENT ON TABLE memory_event_facts IS '故事与事实多对多支撑关系，删除故事不删除事实';
        COMMENT ON COLUMN memory_event_facts.user_id IS '故事及事实共同所属用户';
        COMMENT ON COLUMN memory_event_facts.project_id IS '故事及事实共同所属鉴权项目';
        COMMENT ON COLUMN memory_event_facts.event_id IS '派生故事';
        COMMENT ON COLUMN memory_event_facts.fact_id IS '支撑故事的事实';
        COMMENT ON TABLE memory_deleted_events IS '明确删除的事件身份墓碑，禁止后台恢复同一事件';
        COMMENT ON COLUMN memory_deleted_events.user_id IS '事件原所属用户';
        COMMENT ON COLUMN memory_deleted_events.project_id IS '事件原所属鉴权项目';
        COMMENT ON COLUMN memory_deleted_events.id IS '已删除事件身份';
        COMMENT ON COLUMN memory_profile_revisions.maintenance_version IS '异步画像阶段的固定提交水位；不是任意挑选的导入回执';
    """)
    # One JSON representation, checked against final transaction state. Message
    # withdrawal may mark a message before removing its dependent correction edge.
    op.execute("""
        CREATE FUNCTION validate_memory_correction_support(origin_id UUID, target_id UUID, owner_project VARCHAR)
        RETURNS void LANGUAGE plpgsql AS $$
        DECLARE edge memory_fact_corrections; origin memory_facts; batch memory_blobs;
                group_ids jsonb; canonical jsonb; seen jsonb := '[]'; mid text;
        BEGIN
            SELECT * INTO edge FROM memory_fact_corrections
                WHERE fact_id=origin_id AND corrected_fact_id=target_id AND project_id=owner_project;
            IF NOT FOUND THEN RETURN; END IF;
            SELECT * INTO origin FROM memory_facts
                WHERE id=edge.fact_id AND user_id=edge.user_id AND project_id=edge.project_id;
            IF NOT FOUND THEN RAISE EXCEPTION 'invalid correction owner' USING ERRCODE='23514'; END IF;
            SELECT * INTO batch FROM memory_blobs
                WHERE id=origin.blob_id AND user_id=origin.user_id AND project_id=origin.project_id;
            IF NOT FOUND OR jsonb_typeof(edge.support_groups) IS DISTINCT FROM 'array' THEN
                RAISE EXCEPTION 'invalid correction support' USING ERRCODE='23514'; END IF;
            IF jsonb_array_length(edge.support_groups)=0
                OR jsonb_typeof(origin.support_groups) IS DISTINCT FROM 'array' THEN
                RAISE EXCEPTION 'empty correction support' USING ERRCODE='23514'; END IF;
            FOR group_ids IN SELECT value FROM jsonb_array_elements(edge.support_groups) LOOP
                IF jsonb_typeof(group_ids) IS DISTINCT FROM 'array' THEN
                    RAISE EXCEPTION 'invalid correction group' USING ERRCODE='23514'; END IF;
                IF jsonb_array_length(group_ids)=0
                    OR EXISTS(SELECT 1 FROM jsonb_array_elements(group_ids) v WHERE jsonb_typeof(v)!='string')
                    OR jsonb_array_length(group_ids)!=(SELECT count(DISTINCT value) FROM jsonb_array_elements_text(group_ids)) THEN
                    RAISE EXCEPTION 'invalid correction members' USING ERRCODE='23514'; END IF;
                SELECT jsonb_agg(value ORDER BY value) INTO canonical FROM jsonb_array_elements_text(group_ids);
                IF EXISTS(SELECT 1 FROM jsonb_array_elements(seen) v WHERE v=canonical) THEN
                    RAISE EXCEPTION 'duplicate correction support group' USING ERRCODE='23514'; END IF;
                seen := seen || jsonb_build_array(canonical);
                FOR mid IN SELECT jsonb_array_elements_text(group_ids) LOOP
                    IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(origin.support_groups) g WHERE g ? mid)
                        OR NOT EXISTS(SELECT 1 FROM memory_messages
                            WHERE user_id=batch.user_id AND project_id=batch.project_id AND source_id=batch.source_id
                                AND message_id=mid AND NOT deleted) THEN
                        RAISE EXCEPTION 'correction outside active origin evidence' USING ERRCODE='23514'; END IF;
                END LOOP;
                IF NOT EXISTS(SELECT 1 FROM memory_messages
                    WHERE user_id=batch.user_id AND project_id=batch.project_id AND source_id=batch.source_id
                        AND message_id IN (SELECT jsonb_array_elements_text(group_ids)) AND NOT deleted AND role='user') THEN
                    RAISE EXCEPTION 'correction lacks user evidence' USING ERRCODE='23514'; END IF;
            END LOOP;
        END $$;
        CREATE FUNCTION check_memory_correction_support() RETURNS trigger LANGUAGE plpgsql AS $$
        DECLARE edge RECORD;
        BEGIN
            IF TG_TABLE_NAME='memory_fact_corrections' THEN
                PERFORM validate_memory_correction_support(NEW.fact_id,NEW.corrected_fact_id,NEW.project_id);
            ELSIF TG_TABLE_NAME='memory_facts' THEN
                FOR edge IN SELECT fact_id,corrected_fact_id,project_id FROM memory_fact_corrections
                    WHERE fact_id=NEW.id AND user_id=NEW.user_id AND project_id=NEW.project_id LOOP
                    PERFORM validate_memory_correction_support(edge.fact_id,edge.corrected_fact_id,edge.project_id);
                END LOOP;
            ELSIF TG_TABLE_NAME='memory_blobs' THEN
                FOR edge IN SELECT c.fact_id,c.corrected_fact_id,c.project_id
                    FROM memory_fact_corrections c JOIN memory_facts f
                        ON (f.id,f.user_id,f.project_id)=(c.fact_id,c.user_id,c.project_id)
                    WHERE f.blob_id=NEW.id LOOP
                    PERFORM validate_memory_correction_support(edge.fact_id,edge.corrected_fact_id,edge.project_id);
                END LOOP;
            ELSE
                IF EXISTS(SELECT 1 FROM memory_messages WHERE user_id=OLD.user_id AND project_id=OLD.project_id
                    AND source_id=OLD.source_id AND message_id=OLD.message_id AND NOT deleted) THEN RETURN NULL; END IF;
                FOR edge IN SELECT c.fact_id,c.corrected_fact_id,c.project_id
                    FROM memory_fact_corrections c JOIN memory_facts f
                        ON (f.id,f.user_id,f.project_id)=(c.fact_id,c.user_id,c.project_id)
                    JOIN memory_blobs b ON (b.id,b.user_id,b.project_id)=(f.blob_id,f.user_id,f.project_id)
                    WHERE b.user_id=OLD.user_id AND b.project_id=OLD.project_id AND b.source_id=OLD.source_id
                        AND c.support_groups @> jsonb_build_array(jsonb_build_array(OLD.message_id)) LOOP
                    PERFORM validate_memory_correction_support(edge.fact_id,edge.corrected_fact_id,edge.project_id);
                END LOOP;
            END IF;
            RETURN NULL;
        END $$;
        CREATE CONSTRAINT TRIGGER memory_correction_evidence
            AFTER INSERT OR UPDATE ON memory_fact_corrections DEFERRABLE INITIALLY DEFERRED
            FOR EACH ROW EXECUTE FUNCTION check_memory_correction_support();
        CREATE CONSTRAINT TRIGGER memory_correction_origin_evidence
            AFTER INSERT OR UPDATE ON memory_facts DEFERRABLE INITIALLY DEFERRED
            FOR EACH ROW EXECUTE FUNCTION check_memory_correction_support();
        CREATE CONSTRAINT TRIGGER memory_correction_message_evidence
            AFTER UPDATE OR DELETE ON memory_messages DEFERRABLE INITIALLY DEFERRED
            FOR EACH ROW EXECUTE FUNCTION check_memory_correction_support();
        CREATE CONSTRAINT TRIGGER memory_correction_blob_evidence
            AFTER UPDATE ON memory_blobs DEFERRABLE INITIALLY DEFERRED
            FOR EACH ROW WHEN (OLD.source_id IS DISTINCT FROM NEW.source_id
                OR OLD.user_id IS DISTINCT FROM NEW.user_id OR OLD.project_id IS DISTINCT FROM NEW.project_id)
            EXECUTE FUNCTION check_memory_correction_support();
        COMMENT ON FUNCTION validate_memory_correction_support(UUID,UUID,VARCHAR)
            IS '纠正证据单份 JSON 的最终状态校验，限定原事实所属来源及有效支撑消息';
        COMMENT ON FUNCTION check_memory_correction_support()
            IS '纠正边、原事实、批次归属和消息变化均在事务结束校验，允许同事务删除贡献和清理关联';
    """)
    op.execute("""
        CREATE TABLE memory_maintenance_tasks (
          user_id UUID NOT NULL, project_id VARCHAR(64) NOT NULL, task_id UUID NOT NULL UNIQUE,
          requested_version BIGINT NOT NULL DEFAULT 0, profile_version BIGINT NOT NULL DEFAULT 0,
          event_version BIGINT NOT NULL DEFAULT 0, changes JSONB NOT NULL DEFAULT '[]',
          pending_since TIMESTAMPTZ, available_at TIMESTAMPTZ, target_version BIGINT,
          lease_owner UUID, lease_until TIMESTAMPTZ, generation BIGINT NOT NULL DEFAULT 0,
          attempts BIGINT NOT NULL DEFAULT 0, last_error JSONB, updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          PRIMARY KEY(user_id,project_id),
          FOREIGN KEY(user_id,project_id) REFERENCES users(id,project_id) ON DELETE CASCADE,
          CHECK(profile_version >= 0 AND event_version >= 0 AND requested_version >= profile_version AND requested_version >= event_version),
          CHECK(attempts BETWEEN 0 AND 4), CHECK((lease_owner IS NULL) = (lease_until IS NULL)));
        CREATE INDEX idx_memory_maintenance_ready ON memory_maintenance_tasks(available_at,lease_until);
        COMMENT ON TABLE memory_maintenance_tasks IS '每用户唯一可合并维护任务，Profile 与 Event 串行，各自记录成功进度';
        COMMENT ON COLUMN memory_maintenance_tasks.user_id IS '本任务唯一可以读取和维护的用户';
        COMMENT ON COLUMN memory_maintenance_tasks.project_id IS '本任务唯一可以读取和维护的鉴权项目';
        COMMENT ON COLUMN memory_maintenance_tasks.task_id IS '显式恢复时定位原任务，不另建预算';
        COMMENT ON COLUMN memory_maintenance_tasks.requested_version IS '事实写入请求维护到的最新水位';
        COMMENT ON COLUMN memory_maintenance_tasks.profile_version IS '画像阶段已原子提交的水位';
        COMMENT ON COLUMN memory_maintenance_tasks.event_version IS '故事阶段已原子提交的水位';
        COMMENT ON COLUMN memory_maintenance_tasks.changes IS '带水位的事实新增、删除、纠正、证据和时间变更引用，不含聊天原文';
        COMMENT ON COLUMN memory_maintenance_tasks.pending_since IS '本轮待处理变更首次到达时间，限制持续推迟';
        COMMENT ON COLUMN memory_maintenance_tasks.available_at IS '静默合并或失败退避后可以领取的时间';
        COMMENT ON COLUMN memory_maintenance_tasks.target_version IS '当前执行或恢复轮次的固定水位';
        COMMENT ON COLUMN memory_maintenance_tasks.lease_owner IS '当前维护执行者，不等同于事实写入 Redis 租约';
        COMMENT ON COLUMN memory_maintenance_tasks.lease_until IS '维护执行租约期限';
        COMMENT ON COLUMN memory_maintenance_tasks.generation IS '每次接管递增，阻止失去执行权后的旧结果提交';
        COMMENT ON COLUMN memory_maintenance_tasks.attempts IS '当前阶段及固定水位的累计尝试次数，新输入不重置';
        COMMENT ON COLUMN memory_maintenance_tasks.last_error IS '脱敏失败代码和可恢复性';
        COMMENT ON COLUMN memory_maintenance_tasks.updated_at IS '维护任务最后状态变更时间';
    """)


def downgrade():
    raise RuntimeError("Derived maintenance is persistent business data; use a forward migration")
