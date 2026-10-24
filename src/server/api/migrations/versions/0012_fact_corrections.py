"""Explicit targeted corrections and truthful Fact persistence timestamps."""
from alembic import op

revision = "0012_fact_corrections"
down_revision = "0011_retire_gists"
branch_labels = None
depends_on = None


def upgrade():
    op.execute("""
        ALTER TABLE memory_facts ADD COLUMN created_at TIMESTAMPTZ,
          ADD COLUMN updated_at TIMESTAMPTZ;
        ALTER TABLE memory_facts ALTER COLUMN created_at SET DEFAULT now(),
          ALTER COLUMN updated_at SET DEFAULT now();
        COMMENT ON COLUMN memory_facts.created_at IS '事实首次持久化时间；旧记录未知且保持空值，不以来源或迁移时间猜补';
        COMMENT ON COLUMN memory_facts.updated_at IS '事实正文、主体、报告者、确定性、证据或事件时间最近修改的持久化时间；旧记录未知保持空值';
        ALTER TABLE memory_operations DROP CONSTRAINT memory_operations_kind_check,
          ADD CONSTRAINT memory_operations_kind_check CHECK(kind IN ('import','retract','correct','legacy_import','flush')),
          DROP CONSTRAINT ck_memory_fact_operation_blob,
          ADD CONSTRAINT ck_memory_fact_operation_blob CHECK(kind NOT IN ('import','retract','correct') OR blob_id IS NOT NULL);
        ALTER TABLE memory_blobs DROP CONSTRAINT ck_memory_blob_kind,
          ADD CONSTRAINT ck_memory_blob_kind CHECK(kind IN ('import','retract','correct'));
        DROP INDEX uq_memory_fact_operation_blob;
        CREATE UNIQUE INDEX uq_memory_fact_operation_blob ON memory_operations(blob_id)
          WHERE kind IN ('import','retract','correct');
        COMMENT ON COLUMN memory_blobs.kind IS '本固定批次的消息导入、消息删除或定点事实纠正类型';
        COMMENT ON COLUMN memory_operations.kind IS '导入、消息删除、定点事实纠正、历史导入或派生维护的操作身份';
        COMMENT ON COLUMN memory_operations.input_expires_at IS '未完成导入或纠正的临时输入到期时间；重试不延长，完成或到期清除正文';
    """)


def downgrade():
    raise RuntimeError("Correction receipts are persistent business data; use a forward migration")
