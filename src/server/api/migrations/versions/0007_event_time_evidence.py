"""Separate event calendar time from source message recording time."""
from alembic import op

revision = "0007_event_time_evidence"
down_revision = "0006_source_blob_messages"
branch_labels = None
depends_on = None


def upgrade():
    op.execute("ALTER TABLE memory_messages ADD COLUMN time_zone VARCHAR(100)")
    op.execute("ALTER TABLE memory_facts ADD COLUMN event_time JSONB")
    op.execute("COMMENT ON COLUMN memory_messages.time_zone IS '来源消息记录时的 IANA 时区；未知时为空'")
    op.execute("COMMENT ON COLUMN memory_facts.event_time IS '事件发生日期范围、精度与原始时间证据；不是消息记录时间，旧记录不推测回填'")


def downgrade():
    raise RuntimeError("Event time evidence is persistent business data; use a forward migration")
