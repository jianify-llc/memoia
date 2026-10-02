"""Persist accepted profile versions, excluding withdrawn positive evidence."""
from alembic import op

revision = "0003_profile_history"
down_revision = "0002_sources_v2"
branch_labels = depends_on = None


def upgrade():
    op.execute("""CREATE TABLE memory_profile_revisions (
        id UUID PRIMARY KEY, user_id UUID NOT NULL, project_id VARCHAR(64) NOT NULL,
        operation_id UUID NOT NULL UNIQUE REFERENCES memory_operations(id) ON DELETE CASCADE,
        source_id UUID NOT NULL, profiles JSONB NOT NULL, added JSONB NOT NULL, removed JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        FOREIGN KEY(user_id, project_id) REFERENCES users(id, project_id) ON DELETE CASCADE
    )""")
    op.execute("CREATE INDEX idx_memory_profile_revisions_user ON memory_profile_revisions(user_id, project_id, created_at, id)")
    op.execute("COMMENT ON TABLE memory_profile_revisions IS '已提交画像版本；撤回后清除依赖失效证据的历史内容'")


def downgrade():
    raise RuntimeError("Data-bearing migrations require an explicit maintenance recovery")
