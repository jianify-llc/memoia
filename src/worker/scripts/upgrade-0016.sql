-- Apply only after the existing Alembic revision 0016_source_cascade.
ALTER TABLE memoia.memory_user_states ADD COLUMN writer_lease_until timestamptz;
COMMENT ON COLUMN memoia.memory_user_states.writer_lease_until IS '当前用户写入租约的到期时间，generation 用于隔离过期写入者';

ALTER TABLE memoia.memory_operations ADD COLUMN dispatch_reserved_until timestamptz;
COMMENT ON COLUMN memoia.memory_operations.dispatch_reserved_until IS '操作派发预约的到期时间，防止重复派发';

CREATE TABLE memoia.usage_counters (
    project_id varchar(64) NOT NULL REFERENCES memoia.projects(project_id) ON DELETE CASCADE,
    name varchar(128) NOT NULL,
    period_type varchar(5) NOT NULL CHECK (period_type IN ('day', 'month')),
    period_start date NOT NULL,
    value bigint NOT NULL DEFAULT 0,
    expires_at timestamptz NOT NULL,
    PRIMARY KEY (project_id, name, period_type, period_start)
);
CREATE INDEX idx_usage_counters_expires_at ON memoia.usage_counters(expires_at);
COMMENT ON TABLE memoia.usage_counters IS '按日和按月汇总的近似用量计数，不作为账本';
COMMENT ON COLUMN memoia.usage_counters.project_id IS '所属项目';
COMMENT ON COLUMN memoia.usage_counters.name IS '用量指标名称';
COMMENT ON COLUMN memoia.usage_counters.period_type IS '统计周期，day 或 month';
COMMENT ON COLUMN memoia.usage_counters.period_start IS '统计周期起始日期';
COMMENT ON COLUMN memoia.usage_counters.value IS '周期内累计值';
COMMENT ON COLUMN memoia.usage_counters.expires_at IS '计数可清理的时间';
