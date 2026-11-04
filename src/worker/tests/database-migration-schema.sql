--
-- PostgreSQL database dump
--


-- Dumped from database version 17.11 (Debian 17.11-1.pgdg12+2)
-- Dumped by pg_dump version 17.11 (Debian 17.11-1.pgdg12+2)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: memoia; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA memoia;
CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA memoia;
SELECT pg_catalog.set_config('search_path',
    pg_catalog.format('memoia,%I,extensions,public', n.nspname), false)
FROM pg_catalog.pg_extension e JOIN pg_catalog.pg_namespace n ON n.oid=e.extnamespace
WHERE e.extname='vector';


--
-- Name: check_memory_blob_flush(); Type: FUNCTION; Schema: memoia; Owner: -
--

CREATE FUNCTION memoia.check_memory_blob_flush() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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


--
-- Name: check_memory_blob_messages(); Type: FUNCTION; Schema: memoia; Owner: -
--

CREATE FUNCTION memoia.check_memory_blob_messages() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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
    END $$;


--
-- Name: check_memory_evidence(); Type: FUNCTION; Schema: memoia; Owner: -
--

CREATE FUNCTION memoia.check_memory_evidence() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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
    END $$;


--
-- Name: check_memory_message_delete(); Type: FUNCTION; Schema: memoia; Owner: -
--

CREATE FUNCTION memoia.check_memory_message_delete() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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
    END $$;


--
-- Name: guard_fixed_memory_batch(); Type: FUNCTION; Schema: memoia; Owner: -
--

CREATE FUNCTION memoia.guard_fixed_memory_batch() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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


--
-- Name: guard_memory_flush_request(); Type: FUNCTION; Schema: memoia; Owner: -
--

CREATE FUNCTION memoia.guard_memory_flush_request() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
        BEGIN
          IF OLD.kind='flush' THEN
            IF NEW.kind IS DISTINCT FROM OLD.kind OR NEW.request_hash IS DISTINCT FROM OLD.request_hash
              OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
              OR (NEW.request - 'reasoning_mode') IS DISTINCT FROM (OLD.request - 'reasoning_mode') THEN
              RAISE EXCEPTION 'fixed flush identity is immutable' USING ERRCODE='23514';
            END IF;
            IF NEW.request IS DISTINCT FROM OLD.request AND NOT COALESCE(
              NOT (OLD.request ? 'reasoning_mode')
                AND NEW.request ->> 'reasoning_mode' IN ('standard', 'pro'), false) THEN
              RAISE EXCEPTION 'frozen flush reasoning mode is immutable' USING ERRCODE='23514';
            END IF;
          END IF;
          RETURN NEW;
        END $$;


--
-- Name: FUNCTION guard_memory_flush_request(); Type: COMMENT; Schema: memoia; Owner: -
--

COMMENT ON FUNCTION memoia.guard_memory_flush_request() IS '固定派生批次身份不可变；首次执行允许写入推理模式，冻结后不可变';


--
-- Name: guard_memory_message_identity(); Type: FUNCTION; Schema: memoia; Owner: -
--

CREATE FUNCTION memoia.guard_memory_message_identity() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
        IF ROW(NEW.user_id,NEW.project_id,NEW.source_id,NEW.message_id,NEW.content_hash,NEW.role,NEW.occurred_at)
            IS DISTINCT FROM ROW(OLD.user_id,OLD.project_id,OLD.source_id,OLD.message_id,OLD.content_hash,OLD.role,OLD.occurred_at)
            OR (OLD.deleted AND NOT NEW.deleted) OR (OLD.processed AND NOT NEW.processed) THEN
            RAISE EXCEPTION 'message identity is immutable' USING ERRCODE='23514'; END IF;
        RETURN NEW;
    END $$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: alembic_version; Type: TABLE; Schema: memoia; Owner: -
--

CREATE TABLE memoia.alembic_version (
    version_num character varying(32) NOT NULL
);


--
-- Name: billings; Type: TABLE; Schema: memoia; Owner: -
--

CREATE TABLE memoia.billings (
    usage_left integer,
    next_refill_at timestamp with time zone,
    id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: buffer_zones; Type: TABLE; Schema: memoia; Owner: -
--

CREATE TABLE memoia.buffer_zones (
    blob_type character varying(16) NOT NULL,
    token_size integer NOT NULL,
    user_id uuid NOT NULL,
    blob_id uuid NOT NULL,
    status character varying(16) NOT NULL,
    project_id character varying(64) NOT NULL,
    id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: general_blobs; Type: TABLE; Schema: memoia; Owner: -
--

CREATE TABLE memoia.general_blobs (
    user_id uuid NOT NULL,
    blob_type character varying(16) NOT NULL,
    blob_data jsonb NOT NULL,
    project_id character varying(64) NOT NULL,
    additional_fields jsonb,
    id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: memory_blobs; Type: TABLE; Schema: memoia; Owner: -
--

CREATE TABLE memoia.memory_blobs (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    project_id character varying(64) NOT NULL,
    status character varying(16) NOT NULL,
    event_id uuid,
    event_deleted boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    source_id character varying(255) NOT NULL,
    message_ids jsonb NOT NULL,
    kind character varying(16) DEFAULT 'import'::character varying NOT NULL,
    fact_changes jsonb DEFAULT '[]'::jsonb NOT NULL,
    fact_completed_at timestamp with time zone,
    flush_operation_id uuid,
    CONSTRAINT ck_memory_blob_changes CHECK ((jsonb_typeof(fact_changes) = 'array'::text)),
    CONSTRAINT ck_memory_blob_kind CHECK (((kind)::text = ANY ((ARRAY['import'::character varying, 'retract'::character varying, 'correct'::character varying])::text[]))),
    CONSTRAINT memory_sources_status_check CHECK (((status)::text = ANY ((ARRAY['active'::character varying, 'retracted'::character varying, 'rebuilding'::character varying])::text[])))
);


--
-- Name: COLUMN memory_blobs.source_id; Type: COMMENT; Schema: memoia; Owner: -
--

COMMENT ON COLUMN memoia.memory_blobs.source_id IS '本批输入所属来源';


--
-- Name: COLUMN memory_blobs.message_ids; Type: COMMENT; Schema: memoia; Owner: -
--

COMMENT ON COLUMN memoia.memory_blobs.message_ids IS '本批固定消息身份清单';


--
-- Name: COLUMN memory_blobs.kind; Type: COMMENT; Schema: memoia; Owner: -
--

COMMENT ON COLUMN memoia.memory_blobs.kind IS '本固定批次的消息导入、消息删除或定点事实纠正类型';


--
-- Name: COLUMN memory_blobs.fact_changes; Type: COMMENT; Schema: memoia; Owner: -
--

COMMENT ON COLUMN memoia.memory_blobs.fact_changes IS '本次事务已提交的事实变更引用及水位，不保存聊天正文';


--
-- Name: COLUMN memory_blobs.fact_completed_at; Type: COMMENT; Schema: memoia; Owner: -
--

COMMENT ON COLUMN memoia.memory_blobs.fact_completed_at IS '事实操作提交时间，自动合批只选择已完成批次';


--
-- Name: COLUMN memory_blobs.flush_operation_id; Type: COMMENT; Schema: memoia; Owner: -
--

COMMENT ON COLUMN memoia.memory_blobs.flush_operation_id IS '封闭后唯一所属的用户级 flush Operation，跨来源不伪造 Source';


--
-- Name: memory_deleted_events; Type: TABLE; Schema: memoia; Owner: -
--

CREATE TABLE memoia.memory_deleted_events (
    user_id uuid NOT NULL,
    project_id character varying(64) NOT NULL,
    id uuid NOT NULL
);


--
-- Name: TABLE memory_deleted_events; Type: COMMENT; Schema: memoia; Owner: -
--

COMMENT ON TABLE memoia.memory_deleted_events IS '明确删除的事件身份墓碑，禁止后台恢复同一事件';


--
-- Name: COLUMN memory_deleted_events.user_id; Type: COMMENT; Schema: memoia; Owner: -
--

COMMENT ON COLUMN memoia.memory_deleted_events.user_id IS '事件原所属用户';


--
-- Name: COLUMN memory_deleted_events.project_id; Type: COMMENT; Schema: memoia; Owner: -
--

COMMENT ON COLUMN memoia.memory_deleted_events.project_id IS '事件原所属鉴权项目';


--
-- Name: COLUMN memory_deleted_events.id; Type: COMMENT; Schema: memoia; Owner: -
--

COMMENT ON COLUMN memoia.memory_deleted_events.id IS '已删除事件身份';


--
-- Name: memory_event_facts; Type: TABLE; Schema: memoia; Owner: -
--

CREATE TABLE memoia.memory_event_facts (
    user_id uuid NOT NULL,
    project_id character varying(64) NOT NULL,
    event_id uuid NOT NULL,
    fact_id uuid NOT NULL
);


--
-- Name: TABLE memory_event_facts; Type: COMMENT; Schema: memoia; Owner: -
--

COMMENT ON TABLE memoia.memory_event_facts IS '故事与事实多对多支撑关系，删除故事不删除事实';


--
-- Name: COLUMN memory_event_facts.user_id; Type: COMMENT; Schema: memoia; Owner: -
--

COMMENT ON COLUMN memoia.memory_event_facts.user_id IS '故事及事实共同所属用户';


--
-- Name: COLUMN memory_event_facts.project_id; Type: COMMENT; Schema: memoia; Owner: -
--

COMMENT ON COLUMN memoia.memory_event_facts.project_id IS '故事及事实共同所属鉴权项目';


--
-- Name: COLUMN memory_event_facts.event_id; Type: COMMENT; Schema: memoia; Owner: -
--

COMMENT ON COLUMN memoia.memory_event_facts.event_id IS '派生故事';


--
-- Name: COLUMN memory_event_facts.fact_id; Type: COMMENT; Schema: memoia; Owner: -
--

COMMENT ON COLUMN memoia.memory_event_facts.fact_id IS '支撑故事的事实';


--
-- Name: memory_facts; Type: TABLE; Schema: memoia; Owner: -
--

CREATE TABLE memoia.memory_facts (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    project_id character varying(64) NOT NULL,
    blob_id uuid NOT NULL,
    content character varying NOT NULL,
    topic character varying(128),
    sub_topic character varying(128),
    support_groups jsonb NOT NULL,
    occurred_at timestamp with time zone NOT NULL,
    included boolean DEFAULT true NOT NULL,
    fact_time jsonb,
    subject character varying(512),
    reporter character varying(512),
    certainty character varying(16) DEFAULT 'legacy'::character varying NOT NULL,
    revision bigint DEFAULT 1 NOT NULL,
    created_version bigint DEFAULT 0 NOT NULL,
    search_text text,
    embedding vector(1536),
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    CONSTRAINT ck_memory_facts_certainty CHECK (((certainty)::text = ANY ((ARRAY['legacy'::character varying, 'asserted'::character varying, 'reported'::character varying, 'uncertain'::character varying])::text[]))),
    CONSTRAINT ck_memory_facts_revision CHECK (((revision > 0) AND (created_version >= 0)))
);


--
-- Name: COLUMN memory_facts.blob_id; Type: COMMENT; Schema: memoia; Owner: -
--

COMMENT ON COLUMN memoia.memory_facts.blob_id IS '抽取此事实的输入批次';


--
-- Name: COLUMN memory_facts.fact_time; Type: COMMENT; Schema: memoia; Owner: -
--

COMMENT ON COLUMN memoia.memory_facts.fact_time IS '事实发生日期范围、精度与原始时间证据；不是消息记录时间，旧记录不推测回填';


--
-- Name: COLUMN memory_facts.subject; Type: COMMENT; Schema: memoia; Owner: -
--

COMMENT ON COLUMN memoia.memory_facts.subject IS '事实被断言的主体；旧事实未知，不推测回填';


--
-- Name: COLUMN memory_facts.reporter; Type: COMMENT; Schema: memoia; Owner: -
--

COMMENT ON COLUMN memoia.memory_facts.reporter IS '陈述报告者，不等同于事实主体';


--
-- Name: COLUMN memory_facts.certainty; Type: COMMENT; Schema: memoia; Owner: -
--

COMMENT ON COLUMN memoia.memory_facts.certainty IS '断言、转述、不确定或历史未知，不将推测升级为确定事实';


--
-- Name: COLUMN memory_facts.revision; Type: COMMENT; Schema: memoia; Owner: -
--

COMMENT ON COLUMN memoia.memory_facts.revision IS '事实正文、证据、时间或有效性改变时递增的提交校验版本';


--
-- Name: COLUMN memory_facts.created_version; Type: COMMENT; Schema: memoia; Owner: -
--

COMMENT ON COLUMN memoia.memory_facts.created_version IS '首次保存的用户记忆水位，阻止维护轮次吞掉后续新增事实';


--
-- Name: COLUMN memory_facts.search_text; Type: COMMENT; Schema: memoia; Owner: -
--

COMMENT ON COLUMN memoia.memory_facts.search_text IS '从事实及发生时间派生的检索文本，不依赖 Event';


--
-- Name: COLUMN memory_facts.embedding; Type: COMMENT; Schema: memoia; Owner: -
--

COMMENT ON COLUMN memoia.memory_facts.embedding IS '直接关联事实的检索向量';


--
-- Name: COLUMN memory_facts.created_at; Type: COMMENT; Schema: memoia; Owner: -
--

COMMENT ON COLUMN memoia.memory_facts.created_at IS '事实首次持久化时间；旧记录未知且保持空值，不以来源或迁移时间猜补';


--
-- Name: COLUMN memory_facts.updated_at; Type: COMMENT; Schema: memoia; Owner: -
--

COMMENT ON COLUMN memoia.memory_facts.updated_at IS '事实正文、主体、报告者、确定性、证据或事件时间最近修改的持久化时间；旧记录未知保持空值';


--
-- Name: memory_messages; Type: TABLE; Schema: memoia; Owner: -
--

CREATE TABLE memoia.memory_messages (
    user_id uuid NOT NULL,
    project_id character varying(64) NOT NULL,
    source_id character varying(255) NOT NULL,
    message_id character varying(255) NOT NULL,
    content_hash character varying(64),
    role character varying(16),
    occurred_at timestamp with time zone,
    processed boolean DEFAULT false NOT NULL,
    deleted boolean DEFAULT false NOT NULL,
    time_zone character varying(100),
    CONSTRAINT memory_messages_check CHECK ((deleted OR ((content_hash IS NOT NULL) AND (role IS NOT NULL) AND (occurred_at IS NOT NULL))))
);


--
-- Name: TABLE memory_messages; Type: COMMENT; Schema: memoia; Owner: -
--

COMMENT ON TABLE memoia.memory_messages IS '来源内稳定消息身份、正文指纹与删除标记；不保存正文';


--
-- Name: COLUMN memory_messages.user_id; Type: COMMENT; Schema: memoia; Owner: -
--

COMMENT ON COLUMN memoia.memory_messages.user_id IS '消息所属用户';


--
-- Name: COLUMN memory_messages.project_id; Type: COMMENT; Schema: memoia; Owner: -
--

COMMENT ON COLUMN memoia.memory_messages.project_id IS '消息所属项目';


--
-- Name: COLUMN memory_messages.source_id; Type: COMMENT; Schema: memoia; Owner: -
--

COMMENT ON COLUMN memoia.memory_messages.source_id IS '消息所属来源';


--
-- Name: COLUMN memory_messages.message_id; Type: COMMENT; Schema: memoia; Owner: -
--

COMMENT ON COLUMN memoia.memory_messages.message_id IS '来源内稳定外部消息身份';


--
-- Name: COLUMN memory_messages.content_hash; Type: COMMENT; Schema: memoia; Owner: -
--

COMMENT ON COLUMN memoia.memory_messages.content_hash IS '正文角色时间的不可变指纹，不保存正文';


--
-- Name: COLUMN memory_messages.role; Type: COMMENT; Schema: memoia; Owner: -
--

COMMENT ON COLUMN memoia.memory_messages.role IS '消息角色';


--
-- Name: COLUMN memory_messages.occurred_at; Type: COMMENT; Schema: memoia; Owner: -
--

COMMENT ON COLUMN memoia.memory_messages.occurred_at IS '消息实际发生时间';


--
-- Name: COLUMN memory_messages.processed; Type: COMMENT; Schema: memoia; Owner: -
--

COMMENT ON COLUMN memoia.memory_messages.processed IS '是否已成功参与处理';


--
-- Name: COLUMN memory_messages.deleted; Type: COMMENT; Schema: memoia; Owner: -
--

COMMENT ON COLUMN memoia.memory_messages.deleted IS '永久删除贡献标记';


--
-- Name: COLUMN memory_messages.time_zone; Type: COMMENT; Schema: memoia; Owner: -
--

COMMENT ON COLUMN memoia.memory_messages.time_zone IS '来源消息记录时的 IANA 时区；未知时为空';


--
-- Name: memory_operations; Type: TABLE; Schema: memoia; Owner: -
--

CREATE TABLE memoia.memory_operations (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    project_id character varying(64) NOT NULL,
    idempotency_key character varying(255) NOT NULL,
    kind character varying(16) NOT NULL,
    request_hash character varying(64) NOT NULL,
    request jsonb NOT NULL,
    blob_id uuid,
    status character varying(16) NOT NULL,
    result jsonb,
    error jsonb,
    generation bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    source_id character varying(255),
    input_expires_at timestamp with time zone,
    lease_owner uuid,
    lease_until timestamp with time zone,
    attempts bigint DEFAULT 0 NOT NULL,
    available_at timestamp with time zone,
    CONSTRAINT ck_memory_fact_operation_blob CHECK ((((kind)::text <> ALL ((ARRAY['import'::character varying, 'retract'::character varying, 'correct'::character varying])::text[])) OR (blob_id IS NOT NULL))),
    CONSTRAINT ck_memory_flush_lease CHECK ((((lease_owner IS NULL) = (lease_until IS NULL)) AND ((attempts >= 0) AND (attempts <= 4)) AND (((kind)::text = 'flush'::text) OR ((lease_owner IS NULL) AND (attempts = 0) AND (available_at IS NULL))))),
    CONSTRAINT ck_memory_operation_scope CHECK (((((kind)::text = 'flush'::text) AND (source_id IS NULL) AND (blob_id IS NULL)) OR (((kind)::text <> 'flush'::text) AND (source_id IS NOT NULL)))),
    CONSTRAINT memory_operations_completion_check CHECK (((((status)::text <> 'completed'::text) OR ((result IS NOT NULL) AND (error IS NULL) AND (((kind)::text <> 'import'::text) OR (blob_id IS NOT NULL)))) AND (((status)::text <> 'failed'::text) OR (error IS NOT NULL)))),
    CONSTRAINT memory_operations_kind_check CHECK (((kind)::text = ANY ((ARRAY['import'::character varying, 'retract'::character varying, 'correct'::character varying, 'legacy_import'::character varying, 'flush'::character varying])::text[]))),
    CONSTRAINT memory_operations_legacy_receipt_check CHECK ((((kind)::text <> 'legacy_import'::text) OR (((status)::text = 'completed'::text) AND (blob_id IS NOT NULL) AND (result IS NOT NULL) AND (error IS NULL) AND (NOT (request ? 'messages'::text))))),
    CONSTRAINT memory_operations_status_check CHECK (((status)::text = ANY ((ARRAY['processing'::character varying, 'completed'::character varying, 'failed'::character varying])::text[])))
);


--
-- Name: COLUMN memory_operations.kind; Type: COMMENT; Schema: memoia; Owner: -
--

COMMENT ON COLUMN memoia.memory_operations.kind IS '导入、消息删除、定点事实纠正、历史导入或派生维护的操作身份';


--
-- Name: COLUMN memory_operations.blob_id; Type: COMMENT; Schema: memoia; Owner: -
--

COMMENT ON COLUMN memoia.memory_operations.blob_id IS '导入操作的一一对应批次身份';


--
-- Name: COLUMN memory_operations.source_id; Type: COMMENT; Schema: memoia; Owner: -
--

COMMENT ON COLUMN memoia.memory_operations.source_id IS '操作所属外部来源';


--
-- Name: COLUMN memory_operations.input_expires_at; Type: COMMENT; Schema: memoia; Owner: -
--

COMMENT ON COLUMN memoia.memory_operations.input_expires_at IS '未完成导入或纠正的临时输入到期时间；重试不延长，完成或到期清除正文';


--
-- Name: COLUMN memory_operations.lease_owner; Type: COMMENT; Schema: memoia; Owner: -
--

COMMENT ON COLUMN memoia.memory_operations.lease_owner IS 'flush 当前执行者，失败退避不持有执行权';


--
-- Name: COLUMN memory_operations.lease_until; Type: COMMENT; Schema: memoia; Owner: -
--

COMMENT ON COLUMN memoia.memory_operations.lease_until IS 'flush 可续租执行权的截止时间';


--
-- Name: COLUMN memory_operations.attempts; Type: COMMENT; Schema: memoia; Owner: -
--

COMMENT ON COLUMN memoia.memory_operations.attempts IS '该固定 flush 的累计尝试次数，不因新批次而重置';


--
-- Name: COLUMN memory_operations.available_at; Type: COMMENT; Schema: memoia; Owner: -
--

COMMENT ON COLUMN memoia.memory_operations.available_at IS 'flush 下次允许执行时间';


--
-- Name: memory_profile_revisions; Type: TABLE; Schema: memoia; Owner: -
--

CREATE TABLE memoia.memory_profile_revisions (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    project_id character varying(64) NOT NULL,
    operation_id uuid,
    source_id character varying(255),
    profiles jsonb NOT NULL,
    added jsonb NOT NULL,
    removed jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    maintenance_version bigint
);


--
-- Name: TABLE memory_profile_revisions; Type: COMMENT; Schema: memoia; Owner: -
--

COMMENT ON TABLE memoia.memory_profile_revisions IS '已提交画像版本；撤回后清除依赖失效证据的历史内容';


--
-- Name: COLUMN memory_profile_revisions.source_id; Type: COMMENT; Schema: memoia; Owner: -
--

COMMENT ON COLUMN memoia.memory_profile_revisions.source_id IS '本次变化所属来源';


--
-- Name: COLUMN memory_profile_revisions.maintenance_version; Type: COMMENT; Schema: memoia; Owner: -
--

COMMENT ON COLUMN memoia.memory_profile_revisions.maintenance_version IS '异步画像阶段的固定提交水位；不是任意挑选的导入回执';


--
-- Name: memory_sources; Type: TABLE; Schema: memoia; Owner: -
--

CREATE TABLE memoia.memory_sources (
    user_id uuid NOT NULL,
    project_id character varying(64) NOT NULL,
    source_id character varying(255) NOT NULL,
    legacy boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE memory_sources; Type: COMMENT; Schema: memoia; Owner: -
--

COMMENT ON TABLE memoia.memory_sources IS '外部来源分组，不保存聊天正文；legacy 标明无法还原的旧批次来源';


--
-- Name: COLUMN memory_sources.user_id; Type: COMMENT; Schema: memoia; Owner: -
--

COMMENT ON COLUMN memoia.memory_sources.user_id IS '来源所属用户';


--
-- Name: COLUMN memory_sources.project_id; Type: COMMENT; Schema: memoia; Owner: -
--

COMMENT ON COLUMN memoia.memory_sources.project_id IS '鉴权确定的项目';


--
-- Name: COLUMN memory_sources.source_id; Type: COMMENT; Schema: memoia; Owner: -
--

COMMENT ON COLUMN memoia.memory_sources.source_id IS '调用方来源分组身份';


--
-- Name: COLUMN memory_sources.legacy; Type: COMMENT; Schema: memoia; Owner: -
--

COMMENT ON COLUMN memoia.memory_sources.legacy IS '无法还原真实来源的旧协议边界';


--
-- Name: COLUMN memory_sources.created_at; Type: COMMENT; Schema: memoia; Owner: -
--

COMMENT ON COLUMN memoia.memory_sources.created_at IS '来源首次登记时间';


--
-- Name: memory_user_states; Type: TABLE; Schema: memoia; Owner: -
--

CREATE TABLE memoia.memory_user_states (
    user_id uuid NOT NULL,
    project_id character varying(64) NOT NULL,
    generation bigint DEFAULT '0'::bigint NOT NULL,
    version bigint DEFAULT '0'::bigint NOT NULL
);


--
-- Name: memory_user_tombstones; Type: TABLE; Schema: memoia; Owner: -
--

CREATE TABLE memoia.memory_user_tombstones (
    project_id character varying(64) NOT NULL,
    user_id uuid NOT NULL,
    forgotten_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE memory_user_tombstones; Type: COMMENT; Schema: memoia; Owner: -
--

COMMENT ON TABLE memoia.memory_user_tombstones IS '永久遗忘的项目用户身份，不保存正文，不随用户数据级联删除';


--
-- Name: COLUMN memory_user_tombstones.project_id; Type: COMMENT; Schema: memoia; Owner: -
--

COMMENT ON COLUMN memoia.memory_user_tombstones.project_id IS '鉴权项目身份，项目删除时才级联删除墓碑';


--
-- Name: COLUMN memory_user_tombstones.user_id; Type: COMMENT; Schema: memoia; Owner: -
--

COMMENT ON COLUMN memoia.memory_user_tombstones.user_id IS '禁止再次导入或创建的用户 UUID，与项目组成永久身份';


--
-- Name: COLUMN memory_user_tombstones.forgotten_at; Type: COMMENT; Schema: memoia; Owner: -
--

COMMENT ON COLUMN memoia.memory_user_tombstones.forgotten_at IS '首次永久遗忘登记时间，重复遗忘不改写';


--
-- Name: project_api_keys; Type: TABLE; Schema: memoia; Owner: -
--

CREATE TABLE memoia.project_api_keys (
    id uuid NOT NULL,
    project_id character varying(64) NOT NULL,
    name character varying(128) NOT NULL,
    token_hash character varying(64) NOT NULL,
    scopes jsonb NOT NULL,
    expires_at timestamp with time zone,
    revoked_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT project_api_keys_scopes_check CHECK (((jsonb_array_length(scopes) >= 1) AND (jsonb_array_length(scopes) <= 3))),
    CONSTRAINT project_api_keys_scopes_check1 CHECK ((scopes <@ '["read", "write", "admin"]'::jsonb))
);


--
-- Name: TABLE project_api_keys; Type: COMMENT; Schema: memoia; Owner: -
--

COMMENT ON TABLE memoia.project_api_keys IS '项目级 API key，仅保存摘要，逐请求检查撤销、过期及权限';


--
-- Name: project_billings; Type: TABLE; Schema: memoia; Owner: -
--

CREATE TABLE memoia.project_billings (
    project_id character varying(64) NOT NULL,
    billing_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: projects; Type: TABLE; Schema: memoia; Owner: -
--

CREATE TABLE memoia.projects (
    project_id character varying(64) NOT NULL,
    project_secret character varying(255) NOT NULL,
    profile_config text,
    status character varying(16) NOT NULL,
    id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: user_events; Type: TABLE; Schema: memoia; Owner: -
--

CREATE TABLE memoia.user_events (
    event_data jsonb NOT NULL,
    user_id uuid NOT NULL,
    project_id character varying(64) NOT NULL,
    embedding vector(1536),
    id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    revision bigint DEFAULT 1 NOT NULL
);


--
-- Name: COLUMN user_events.revision; Type: COMMENT; Schema: memoia; Owner: -
--

COMMENT ON COLUMN memoia.user_events.revision IS '事件修改版本，防止维护阶段覆盖并发编辑';


--
-- Name: user_profiles; Type: TABLE; Schema: memoia; Owner: -
--

CREATE TABLE memoia.user_profiles (
    content text NOT NULL,
    user_id uuid NOT NULL,
    attributes jsonb,
    project_id character varying(64) NOT NULL,
    id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    revision bigint DEFAULT 1 NOT NULL
);


--
-- Name: COLUMN user_profiles.revision; Type: COMMENT; Schema: memoia; Owner: -
--

COMMENT ON COLUMN memoia.user_profiles.revision IS '画像修改版本，防止维护阶段覆盖并发编辑';


--
-- Name: user_statuses; Type: TABLE; Schema: memoia; Owner: -
--

CREATE TABLE memoia.user_statuses (
    type character varying(32) NOT NULL,
    attributes jsonb NOT NULL,
    user_id uuid NOT NULL,
    project_id character varying(64) NOT NULL,
    id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: users; Type: TABLE; Schema: memoia; Owner: -
--

CREATE TABLE memoia.users (
    additional_fields jsonb,
    project_id character varying(64) NOT NULL,
    id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: alembic_version alembic_version_pkc; Type: CONSTRAINT; Schema: memoia; Owner: -
--

ALTER TABLE ONLY memoia.alembic_version
    ADD CONSTRAINT alembic_version_pkc PRIMARY KEY (version_num);


--
-- Name: billings billings_pkey; Type: CONSTRAINT; Schema: memoia; Owner: -
--

ALTER TABLE ONLY memoia.billings
    ADD CONSTRAINT billings_pkey PRIMARY KEY (id);


--
-- Name: buffer_zones buffer_zones_pkey; Type: CONSTRAINT; Schema: memoia; Owner: -
--

ALTER TABLE ONLY memoia.buffer_zones
    ADD CONSTRAINT buffer_zones_pkey PRIMARY KEY (id, project_id);


--
-- Name: general_blobs general_blobs_pkey; Type: CONSTRAINT; Schema: memoia; Owner: -
--

ALTER TABLE ONLY memoia.general_blobs
    ADD CONSTRAINT general_blobs_pkey PRIMARY KEY (id, project_id);


--
-- Name: memory_blobs memory_blobs_id_user_id_project_id_key; Type: CONSTRAINT; Schema: memoia; Owner: -
--

ALTER TABLE ONLY memoia.memory_blobs
    ADD CONSTRAINT memory_blobs_id_user_id_project_id_key UNIQUE (id, user_id, project_id);


--
-- Name: memory_blobs memory_blobs_id_user_id_project_id_source_id_key; Type: CONSTRAINT; Schema: memoia; Owner: -
--

ALTER TABLE ONLY memoia.memory_blobs
    ADD CONSTRAINT memory_blobs_id_user_id_project_id_source_id_key UNIQUE (id, user_id, project_id, source_id);


--
-- Name: memory_deleted_events memory_deleted_events_pkey; Type: CONSTRAINT; Schema: memoia; Owner: -
--

ALTER TABLE ONLY memoia.memory_deleted_events
    ADD CONSTRAINT memory_deleted_events_pkey PRIMARY KEY (id, user_id, project_id);


--
-- Name: memory_event_facts memory_event_facts_pkey; Type: CONSTRAINT; Schema: memoia; Owner: -
--

ALTER TABLE ONLY memoia.memory_event_facts
    ADD CONSTRAINT memory_event_facts_pkey PRIMARY KEY (event_id, fact_id, project_id);


--
-- Name: memory_facts memory_facts_pkey; Type: CONSTRAINT; Schema: memoia; Owner: -
--

ALTER TABLE ONLY memoia.memory_facts
    ADD CONSTRAINT memory_facts_pkey PRIMARY KEY (id);


--
-- Name: memory_messages memory_messages_pkey; Type: CONSTRAINT; Schema: memoia; Owner: -
--

ALTER TABLE ONLY memoia.memory_messages
    ADD CONSTRAINT memory_messages_pkey PRIMARY KEY (user_id, project_id, source_id, message_id);


--
-- Name: memory_operations memory_operations_id_user_id_project_id_key; Type: CONSTRAINT; Schema: memoia; Owner: -
--

ALTER TABLE ONLY memoia.memory_operations
    ADD CONSTRAINT memory_operations_id_user_id_project_id_key UNIQUE (id, user_id, project_id);


--
-- Name: memory_operations memory_operations_id_user_id_project_id_source_id_key; Type: CONSTRAINT; Schema: memoia; Owner: -
--

ALTER TABLE ONLY memoia.memory_operations
    ADD CONSTRAINT memory_operations_id_user_id_project_id_source_id_key UNIQUE (id, user_id, project_id, source_id);


--
-- Name: memory_operations memory_operations_pkey; Type: CONSTRAINT; Schema: memoia; Owner: -
--

ALTER TABLE ONLY memoia.memory_operations
    ADD CONSTRAINT memory_operations_pkey PRIMARY KEY (id);


--
-- Name: memory_operations memory_operations_user_id_project_id_idempotency_key_key; Type: CONSTRAINT; Schema: memoia; Owner: -
--

ALTER TABLE ONLY memoia.memory_operations
    ADD CONSTRAINT memory_operations_user_id_project_id_idempotency_key_key UNIQUE (user_id, project_id, idempotency_key);


--
-- Name: memory_profile_revisions memory_profile_revisions_operation_id_key; Type: CONSTRAINT; Schema: memoia; Owner: -
--

ALTER TABLE ONLY memoia.memory_profile_revisions
    ADD CONSTRAINT memory_profile_revisions_operation_id_key UNIQUE (operation_id);


--
-- Name: memory_profile_revisions memory_profile_revisions_pkey; Type: CONSTRAINT; Schema: memoia; Owner: -
--

ALTER TABLE ONLY memoia.memory_profile_revisions
    ADD CONSTRAINT memory_profile_revisions_pkey PRIMARY KEY (id);


--
-- Name: memory_blobs memory_sources_pkey; Type: CONSTRAINT; Schema: memoia; Owner: -
--

ALTER TABLE ONLY memoia.memory_blobs
    ADD CONSTRAINT memory_sources_pkey PRIMARY KEY (id);


--
-- Name: memory_sources memory_sources_pkey1; Type: CONSTRAINT; Schema: memoia; Owner: -
--

ALTER TABLE ONLY memoia.memory_sources
    ADD CONSTRAINT memory_sources_pkey1 PRIMARY KEY (user_id, project_id, source_id);


--
-- Name: memory_user_states memory_user_states_user_id_project_id_key; Type: CONSTRAINT; Schema: memoia; Owner: -
--

ALTER TABLE ONLY memoia.memory_user_states
    ADD CONSTRAINT memory_user_states_user_id_project_id_key UNIQUE (user_id, project_id);


--
-- Name: memory_user_tombstones memory_user_tombstones_pkey; Type: CONSTRAINT; Schema: memoia; Owner: -
--

ALTER TABLE ONLY memoia.memory_user_tombstones
    ADD CONSTRAINT memory_user_tombstones_pkey PRIMARY KEY (project_id, user_id);


--
-- Name: project_api_keys project_api_keys_pkey; Type: CONSTRAINT; Schema: memoia; Owner: -
--

ALTER TABLE ONLY memoia.project_api_keys
    ADD CONSTRAINT project_api_keys_pkey PRIMARY KEY (id);


--
-- Name: project_billings project_billings_pkey; Type: CONSTRAINT; Schema: memoia; Owner: -
--

ALTER TABLE ONLY memoia.project_billings
    ADD CONSTRAINT project_billings_pkey PRIMARY KEY (project_id, billing_id);


--
-- Name: projects projects_pkey; Type: CONSTRAINT; Schema: memoia; Owner: -
--

ALTER TABLE ONLY memoia.projects
    ADD CONSTRAINT projects_pkey PRIMARY KEY (project_id);


--
-- Name: memory_facts uq_memory_facts_owner; Type: CONSTRAINT; Schema: memoia; Owner: -
--

ALTER TABLE ONLY memoia.memory_facts
    ADD CONSTRAINT uq_memory_facts_owner UNIQUE (id, user_id, project_id);


--
-- Name: memory_profile_revisions uq_profile_maintenance; Type: CONSTRAINT; Schema: memoia; Owner: -
--

ALTER TABLE ONLY memoia.memory_profile_revisions
    ADD CONSTRAINT uq_profile_maintenance UNIQUE (user_id, project_id, maintenance_version);


--
-- Name: user_events uq_user_events_owner; Type: CONSTRAINT; Schema: memoia; Owner: -
--

ALTER TABLE ONLY memoia.user_events
    ADD CONSTRAINT uq_user_events_owner UNIQUE (id, user_id, project_id);


--
-- Name: user_events user_events_pkey; Type: CONSTRAINT; Schema: memoia; Owner: -
--

ALTER TABLE ONLY memoia.user_events
    ADD CONSTRAINT user_events_pkey PRIMARY KEY (id, project_id);


--
-- Name: user_profiles user_profiles_pkey; Type: CONSTRAINT; Schema: memoia; Owner: -
--

ALTER TABLE ONLY memoia.user_profiles
    ADD CONSTRAINT user_profiles_pkey PRIMARY KEY (id, project_id);


--
-- Name: user_statuses user_statuses_pkey; Type: CONSTRAINT; Schema: memoia; Owner: -
--

ALTER TABLE ONLY memoia.user_statuses
    ADD CONSTRAINT user_statuses_pkey PRIMARY KEY (id, project_id);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: memoia; Owner: -
--

ALTER TABLE ONLY memoia.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id, project_id);


--
-- Name: idx_buffer_zones_user_id_blob_type; Type: INDEX; Schema: memoia; Owner: -
--

CREATE INDEX idx_buffer_zones_user_id_blob_type ON memoia.buffer_zones USING btree (user_id, project_id, blob_type, status);


--
-- Name: idx_general_blobs_id_project_id; Type: INDEX; Schema: memoia; Owner: -
--

CREATE UNIQUE INDEX idx_general_blobs_id_project_id ON memoia.general_blobs USING btree (id, project_id);


--
-- Name: idx_general_blobs_user_id_blob_type; Type: INDEX; Schema: memoia; Owner: -
--

CREATE INDEX idx_general_blobs_user_id_blob_type ON memoia.general_blobs USING btree (user_id, project_id, blob_type);


--
-- Name: idx_general_blobs_user_id_id; Type: INDEX; Schema: memoia; Owner: -
--

CREATE INDEX idx_general_blobs_user_id_id ON memoia.general_blobs USING btree (user_id, project_id, id);


--
-- Name: idx_general_blobs_user_id_project_id; Type: INDEX; Schema: memoia; Owner: -
--

CREATE INDEX idx_general_blobs_user_id_project_id ON memoia.general_blobs USING btree (user_id, project_id);


--
-- Name: idx_memory_blob_unflushed; Type: INDEX; Schema: memoia; Owner: -
--

CREATE INDEX idx_memory_blob_unflushed ON memoia.memory_blobs USING btree (user_id, project_id, fact_completed_at, id) WHERE ((flush_operation_id IS NULL) AND (fact_completed_at IS NOT NULL));


--
-- Name: idx_memory_blobs_group; Type: INDEX; Schema: memoia; Owner: -
--

CREATE INDEX idx_memory_blobs_group ON memoia.memory_blobs USING btree (user_id, project_id, source_id, created_at, id);


--
-- Name: idx_memory_blobs_message_ids; Type: INDEX; Schema: memoia; Owner: -
--

CREATE INDEX idx_memory_blobs_message_ids ON memoia.memory_blobs USING gin (message_ids);


--
-- Name: idx_memory_event_facts_reverse; Type: INDEX; Schema: memoia; Owner: -
--

CREATE INDEX idx_memory_event_facts_reverse ON memoia.memory_event_facts USING btree (user_id, project_id, fact_id);


--
-- Name: idx_memory_facts_lexical; Type: INDEX; Schema: memoia; Owner: -
--

CREATE INDEX idx_memory_facts_lexical ON memoia.memory_facts USING gin (to_tsvector('simple'::regconfig, COALESCE(search_text, (content)::text)));


--
-- Name: idx_memory_facts_user; Type: INDEX; Schema: memoia; Owner: -
--

CREATE INDEX idx_memory_facts_user ON memoia.memory_facts USING btree (user_id, project_id, blob_id);


--
-- Name: idx_memory_flush_ready; Type: INDEX; Schema: memoia; Owner: -
--

CREATE INDEX idx_memory_flush_ready ON memoia.memory_operations USING btree (available_at) WHERE (((kind)::text = 'flush'::text) AND ((status)::text <> 'completed'::text));


--
-- Name: idx_memory_operations_user; Type: INDEX; Schema: memoia; Owner: -
--

CREATE INDEX idx_memory_operations_user ON memoia.memory_operations USING btree (user_id, project_id, created_at, id);


--
-- Name: idx_memory_profile_revisions_user; Type: INDEX; Schema: memoia; Owner: -
--

CREATE INDEX idx_memory_profile_revisions_user ON memoia.memory_profile_revisions USING btree (user_id, project_id, created_at, id);


--
-- Name: idx_memory_sources_user; Type: INDEX; Schema: memoia; Owner: -
--

CREATE INDEX idx_memory_sources_user ON memoia.memory_blobs USING btree (user_id, project_id, created_at, id);


--
-- Name: idx_project_api_keys_project; Type: INDEX; Schema: memoia; Owner: -
--

CREATE INDEX idx_project_api_keys_project ON memoia.project_api_keys USING btree (project_id, id);


--
-- Name: idx_project_billings_billing_id; Type: INDEX; Schema: memoia; Owner: -
--

CREATE INDEX idx_project_billings_billing_id ON memoia.project_billings USING btree (billing_id);


--
-- Name: idx_project_billings_project_id; Type: INDEX; Schema: memoia; Owner: -
--

CREATE INDEX idx_project_billings_project_id ON memoia.project_billings USING btree (project_id);


--
-- Name: idx_projects_project_id; Type: INDEX; Schema: memoia; Owner: -
--

CREATE INDEX idx_projects_project_id ON memoia.projects USING btree (project_id);


--
-- Name: idx_user_events_lexical; Type: INDEX; Schema: memoia; Owner: -
--

CREATE INDEX idx_user_events_lexical ON memoia.user_events USING gin (to_tsvector('simple'::regconfig, COALESCE((event_data ->> 'event_tip'::text), ''::text)));


--
-- Name: idx_user_events_user_id_id_project_id; Type: INDEX; Schema: memoia; Owner: -
--

CREATE INDEX idx_user_events_user_id_id_project_id ON memoia.user_events USING btree (user_id, project_id, id);


--
-- Name: idx_user_events_user_id_project_id; Type: INDEX; Schema: memoia; Owner: -
--

CREATE INDEX idx_user_events_user_id_project_id ON memoia.user_events USING btree (user_id, project_id);


--
-- Name: idx_user_profiles_user_id_id_project_id; Type: INDEX; Schema: memoia; Owner: -
--

CREATE INDEX idx_user_profiles_user_id_id_project_id ON memoia.user_profiles USING btree (user_id, project_id, id);


--
-- Name: idx_user_profiles_user_id_project_id; Type: INDEX; Schema: memoia; Owner: -
--

CREATE INDEX idx_user_profiles_user_id_project_id ON memoia.user_profiles USING btree (user_id, project_id);


--
-- Name: idx_user_statuses_user_id_id_project_id; Type: INDEX; Schema: memoia; Owner: -
--

CREATE INDEX idx_user_statuses_user_id_id_project_id ON memoia.user_statuses USING btree (user_id, project_id, id);


--
-- Name: idx_user_statuses_user_id_project_id; Type: INDEX; Schema: memoia; Owner: -
--

CREATE INDEX idx_user_statuses_user_id_project_id ON memoia.user_statuses USING btree (user_id, project_id);


--
-- Name: idx_user_statuses_user_id_project_id_type; Type: INDEX; Schema: memoia; Owner: -
--

CREATE INDEX idx_user_statuses_user_id_project_id_type ON memoia.user_statuses USING btree (user_id, project_id, type);


--
-- Name: idx_users_id_project_id; Type: INDEX; Schema: memoia; Owner: -
--

CREATE INDEX idx_users_id_project_id ON memoia.users USING btree (id, project_id);


--
-- Name: uq_memory_fact_operation_blob; Type: INDEX; Schema: memoia; Owner: -
--

CREATE UNIQUE INDEX uq_memory_fact_operation_blob ON memoia.memory_operations USING btree (blob_id) WHERE ((kind)::text = ANY ((ARRAY['import'::character varying, 'retract'::character varying, 'correct'::character varying])::text[]));


--
-- Name: uq_memory_flush_executor; Type: INDEX; Schema: memoia; Owner: -
--

CREATE UNIQUE INDEX uq_memory_flush_executor ON memoia.memory_operations USING btree (user_id, project_id) WHERE (((kind)::text = 'flush'::text) AND (lease_owner IS NOT NULL));


--
-- Name: memory_blobs memory_blob_fixed_batch; Type: TRIGGER; Schema: memoia; Owner: -
--

CREATE TRIGGER memory_blob_fixed_batch BEFORE UPDATE ON memoia.memory_blobs FOR EACH ROW EXECUTE FUNCTION memoia.guard_fixed_memory_batch();


--
-- Name: memory_blobs memory_blob_flush_owner; Type: TRIGGER; Schema: memoia; Owner: -
--

CREATE CONSTRAINT TRIGGER memory_blob_flush_owner AFTER INSERT OR UPDATE ON memoia.memory_blobs DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION memoia.check_memory_blob_flush();


--
-- Name: memory_blobs memory_blob_message_owner; Type: TRIGGER; Schema: memoia; Owner: -
--

CREATE CONSTRAINT TRIGGER memory_blob_message_owner AFTER INSERT OR UPDATE ON memoia.memory_blobs DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION memoia.check_memory_blob_messages();


--
-- Name: memory_facts memory_evidence_owner; Type: TRIGGER; Schema: memoia; Owner: -
--

CREATE CONSTRAINT TRIGGER memory_evidence_owner AFTER INSERT OR UPDATE ON memoia.memory_facts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION memoia.check_memory_evidence();


--
-- Name: memory_operations memory_flush_fixed_request; Type: TRIGGER; Schema: memoia; Owner: -
--

CREATE TRIGGER memory_flush_fixed_request BEFORE UPDATE ON memoia.memory_operations FOR EACH ROW EXECUTE FUNCTION memoia.guard_memory_flush_request();


--
-- Name: memory_messages memory_message_identity; Type: TRIGGER; Schema: memoia; Owner: -
--

CREATE TRIGGER memory_message_identity BEFORE UPDATE ON memoia.memory_messages FOR EACH ROW EXECUTE FUNCTION memoia.guard_memory_message_identity();


--
-- Name: memory_messages memory_message_support; Type: TRIGGER; Schema: memoia; Owner: -
--

CREATE CONSTRAINT TRIGGER memory_message_support AFTER DELETE OR UPDATE ON memoia.memory_messages DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION memoia.check_memory_message_delete();


--
-- Name: buffer_zones buffer_zones_blob_id_project_id_fkey; Type: FK CONSTRAINT; Schema: memoia; Owner: -
--

ALTER TABLE ONLY memoia.buffer_zones
    ADD CONSTRAINT buffer_zones_blob_id_project_id_fkey FOREIGN KEY (blob_id, project_id) REFERENCES memoia.general_blobs(id, project_id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: buffer_zones buffer_zones_user_id_project_id_fkey; Type: FK CONSTRAINT; Schema: memoia; Owner: -
--

ALTER TABLE ONLY memoia.buffer_zones
    ADD CONSTRAINT buffer_zones_user_id_project_id_fkey FOREIGN KEY (user_id, project_id) REFERENCES memoia.users(id, project_id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: memory_blobs fk_memory_blob_flush; Type: FK CONSTRAINT; Schema: memoia; Owner: -
--

ALTER TABLE ONLY memoia.memory_blobs
    ADD CONSTRAINT fk_memory_blob_flush FOREIGN KEY (flush_operation_id, user_id, project_id) REFERENCES memoia.memory_operations(id, user_id, project_id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: general_blobs general_blobs_user_id_project_id_fkey; Type: FK CONSTRAINT; Schema: memoia; Owner: -
--

ALTER TABLE ONLY memoia.general_blobs
    ADD CONSTRAINT general_blobs_user_id_project_id_fkey FOREIGN KEY (user_id, project_id) REFERENCES memoia.users(id, project_id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: memory_blobs memory_blobs_user_id_project_id_source_id_fkey; Type: FK CONSTRAINT; Schema: memoia; Owner: -
--

ALTER TABLE ONLY memoia.memory_blobs
    ADD CONSTRAINT memory_blobs_user_id_project_id_source_id_fkey FOREIGN KEY (user_id, project_id, source_id) REFERENCES memoia.memory_sources(user_id, project_id, source_id) ON DELETE CASCADE;


--
-- Name: memory_deleted_events memory_deleted_events_user_id_project_id_fkey; Type: FK CONSTRAINT; Schema: memoia; Owner: -
--

ALTER TABLE ONLY memoia.memory_deleted_events
    ADD CONSTRAINT memory_deleted_events_user_id_project_id_fkey FOREIGN KEY (user_id, project_id) REFERENCES memoia.users(id, project_id) ON DELETE CASCADE;


--
-- Name: memory_event_facts memory_event_facts_event_id_user_id_project_id_fkey; Type: FK CONSTRAINT; Schema: memoia; Owner: -
--

ALTER TABLE ONLY memoia.memory_event_facts
    ADD CONSTRAINT memory_event_facts_event_id_user_id_project_id_fkey FOREIGN KEY (event_id, user_id, project_id) REFERENCES memoia.user_events(id, user_id, project_id) ON DELETE CASCADE;


--
-- Name: memory_event_facts memory_event_facts_fact_id_user_id_project_id_fkey; Type: FK CONSTRAINT; Schema: memoia; Owner: -
--

ALTER TABLE ONLY memoia.memory_event_facts
    ADD CONSTRAINT memory_event_facts_fact_id_user_id_project_id_fkey FOREIGN KEY (fact_id, user_id, project_id) REFERENCES memoia.memory_facts(id, user_id, project_id) ON DELETE CASCADE;


--
-- Name: memory_facts memory_facts_blob_id_user_id_project_id_fkey; Type: FK CONSTRAINT; Schema: memoia; Owner: -
--

ALTER TABLE ONLY memoia.memory_facts
    ADD CONSTRAINT memory_facts_blob_id_user_id_project_id_fkey FOREIGN KEY (blob_id, user_id, project_id) REFERENCES memoia.memory_blobs(id, user_id, project_id) ON DELETE CASCADE;


--
-- Name: memory_facts memory_facts_user_id_project_id_fkey; Type: FK CONSTRAINT; Schema: memoia; Owner: -
--

ALTER TABLE ONLY memoia.memory_facts
    ADD CONSTRAINT memory_facts_user_id_project_id_fkey FOREIGN KEY (user_id, project_id) REFERENCES memoia.users(id, project_id) ON DELETE CASCADE;


--
-- Name: memory_messages memory_messages_user_id_project_id_source_id_fkey; Type: FK CONSTRAINT; Schema: memoia; Owner: -
--

ALTER TABLE ONLY memoia.memory_messages
    ADD CONSTRAINT memory_messages_user_id_project_id_source_id_fkey FOREIGN KEY (user_id, project_id, source_id) REFERENCES memoia.memory_sources(user_id, project_id, source_id) ON DELETE CASCADE;


--
-- Name: memory_operations memory_operations_blob_id_user_id_project_id_fkey; Type: FK CONSTRAINT; Schema: memoia; Owner: -
--

ALTER TABLE ONLY memoia.memory_operations
    ADD CONSTRAINT memory_operations_blob_id_user_id_project_id_fkey FOREIGN KEY (blob_id, user_id, project_id) REFERENCES memoia.memory_blobs(id, user_id, project_id) ON DELETE CASCADE;


--
-- Name: memory_operations memory_operations_blob_id_user_id_project_id_source_id_fkey; Type: FK CONSTRAINT; Schema: memoia; Owner: -
--

ALTER TABLE ONLY memoia.memory_operations
    ADD CONSTRAINT memory_operations_blob_id_user_id_project_id_source_id_fkey FOREIGN KEY (blob_id, user_id, project_id, source_id) REFERENCES memoia.memory_blobs(id, user_id, project_id, source_id) ON DELETE CASCADE;


--
-- Name: memory_operations memory_operations_user_id_project_id_fkey; Type: FK CONSTRAINT; Schema: memoia; Owner: -
--

ALTER TABLE ONLY memoia.memory_operations
    ADD CONSTRAINT memory_operations_user_id_project_id_fkey FOREIGN KEY (user_id, project_id) REFERENCES memoia.users(id, project_id) ON DELETE CASCADE;


--
-- Name: memory_operations memory_operations_user_id_project_id_source_id_fkey; Type: FK CONSTRAINT; Schema: memoia; Owner: -
--

ALTER TABLE ONLY memoia.memory_operations
    ADD CONSTRAINT memory_operations_user_id_project_id_source_id_fkey FOREIGN KEY (user_id, project_id, source_id) REFERENCES memoia.memory_sources(user_id, project_id, source_id) ON DELETE CASCADE;


--
-- Name: memory_profile_revisions memory_profile_revisions_operation_id_fkey; Type: FK CONSTRAINT; Schema: memoia; Owner: -
--

ALTER TABLE ONLY memoia.memory_profile_revisions
    ADD CONSTRAINT memory_profile_revisions_operation_id_fkey FOREIGN KEY (operation_id) REFERENCES memoia.memory_operations(id) ON DELETE CASCADE;


--
-- Name: memory_profile_revisions memory_profile_revisions_operation_id_user_id_project_id_s_fkey; Type: FK CONSTRAINT; Schema: memoia; Owner: -
--

ALTER TABLE ONLY memoia.memory_profile_revisions
    ADD CONSTRAINT memory_profile_revisions_operation_id_user_id_project_id_s_fkey FOREIGN KEY (operation_id, user_id, project_id, source_id) REFERENCES memoia.memory_operations(id, user_id, project_id, source_id) ON DELETE CASCADE;


--
-- Name: memory_profile_revisions memory_profile_revisions_user_id_project_id_fkey; Type: FK CONSTRAINT; Schema: memoia; Owner: -
--

ALTER TABLE ONLY memoia.memory_profile_revisions
    ADD CONSTRAINT memory_profile_revisions_user_id_project_id_fkey FOREIGN KEY (user_id, project_id) REFERENCES memoia.users(id, project_id) ON DELETE CASCADE;


--
-- Name: memory_profile_revisions memory_profile_revisions_user_id_project_id_source_id_fkey; Type: FK CONSTRAINT; Schema: memoia; Owner: -
--

ALTER TABLE ONLY memoia.memory_profile_revisions
    ADD CONSTRAINT memory_profile_revisions_user_id_project_id_source_id_fkey FOREIGN KEY (user_id, project_id, source_id) REFERENCES memoia.memory_sources(user_id, project_id, source_id) ON DELETE CASCADE;


--
-- Name: memory_blobs memory_sources_user_id_project_id_fkey; Type: FK CONSTRAINT; Schema: memoia; Owner: -
--

ALTER TABLE ONLY memoia.memory_blobs
    ADD CONSTRAINT memory_sources_user_id_project_id_fkey FOREIGN KEY (user_id, project_id) REFERENCES memoia.users(id, project_id) ON DELETE CASCADE;


--
-- Name: memory_sources memory_sources_user_id_project_id_fkey1; Type: FK CONSTRAINT; Schema: memoia; Owner: -
--

ALTER TABLE ONLY memoia.memory_sources
    ADD CONSTRAINT memory_sources_user_id_project_id_fkey1 FOREIGN KEY (user_id, project_id) REFERENCES memoia.users(id, project_id) ON DELETE CASCADE;


--
-- Name: memory_user_states memory_user_states_user_id_project_id_fkey; Type: FK CONSTRAINT; Schema: memoia; Owner: -
--

ALTER TABLE ONLY memoia.memory_user_states
    ADD CONSTRAINT memory_user_states_user_id_project_id_fkey FOREIGN KEY (user_id, project_id) REFERENCES memoia.users(id, project_id) ON DELETE CASCADE;


--
-- Name: memory_user_tombstones memory_user_tombstones_project_id_fkey; Type: FK CONSTRAINT; Schema: memoia; Owner: -
--

ALTER TABLE ONLY memoia.memory_user_tombstones
    ADD CONSTRAINT memory_user_tombstones_project_id_fkey FOREIGN KEY (project_id) REFERENCES memoia.projects(project_id) ON DELETE CASCADE;


--
-- Name: project_api_keys project_api_keys_project_id_fkey; Type: FK CONSTRAINT; Schema: memoia; Owner: -
--

ALTER TABLE ONLY memoia.project_api_keys
    ADD CONSTRAINT project_api_keys_project_id_fkey FOREIGN KEY (project_id) REFERENCES memoia.projects(project_id) ON DELETE CASCADE;


--
-- Name: project_billings project_billings_billing_id_fkey; Type: FK CONSTRAINT; Schema: memoia; Owner: -
--

ALTER TABLE ONLY memoia.project_billings
    ADD CONSTRAINT project_billings_billing_id_fkey FOREIGN KEY (billing_id) REFERENCES memoia.billings(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: project_billings project_billings_project_id_fkey; Type: FK CONSTRAINT; Schema: memoia; Owner: -
--

ALTER TABLE ONLY memoia.project_billings
    ADD CONSTRAINT project_billings_project_id_fkey FOREIGN KEY (project_id) REFERENCES memoia.projects(project_id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: user_events user_events_user_id_project_id_fkey; Type: FK CONSTRAINT; Schema: memoia; Owner: -
--

ALTER TABLE ONLY memoia.user_events
    ADD CONSTRAINT user_events_user_id_project_id_fkey FOREIGN KEY (user_id, project_id) REFERENCES memoia.users(id, project_id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: user_profiles user_profiles_user_id_project_id_fkey; Type: FK CONSTRAINT; Schema: memoia; Owner: -
--

ALTER TABLE ONLY memoia.user_profiles
    ADD CONSTRAINT user_profiles_user_id_project_id_fkey FOREIGN KEY (user_id, project_id) REFERENCES memoia.users(id, project_id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: user_statuses user_statuses_user_id_project_id_fkey; Type: FK CONSTRAINT; Schema: memoia; Owner: -
--

ALTER TABLE ONLY memoia.user_statuses
    ADD CONSTRAINT user_statuses_user_id_project_id_fkey FOREIGN KEY (user_id, project_id) REFERENCES memoia.users(id, project_id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: users users_project_id_fkey; Type: FK CONSTRAINT; Schema: memoia; Owner: -
--

ALTER TABLE ONLY memoia.users
    ADD CONSTRAINT users_project_id_fkey FOREIGN KEY (project_id) REFERENCES memoia.projects(project_id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--



INSERT INTO memoia.alembic_version(version_num) VALUES ('0016_source_cascade');
