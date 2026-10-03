"""Permanent project/user identity tombstones survive user-data deletion."""
from alembic import op

revision = "0005_user_tombstones"
down_revision = "0004_key_scopes_search"
branch_labels = depends_on = None


def upgrade():
    op.execute("""CREATE TABLE memory_user_tombstones (
        project_id VARCHAR(64) NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
        user_id UUID NOT NULL, forgotten_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (project_id, user_id)
    )""")
    op.execute("COMMENT ON TABLE memory_user_tombstones IS '永久遗忘的项目用户身份，不保存正文，不随用户数据级联删除'")
    op.execute("COMMENT ON COLUMN memory_user_tombstones.project_id IS '鉴权项目身份，项目删除时才级联删除墓碑'")
    op.execute("COMMENT ON COLUMN memory_user_tombstones.user_id IS '禁止再次导入或创建的用户 UUID，与项目组成永久身份'")
    op.execute("COMMENT ON COLUMN memory_user_tombstones.forgotten_at IS '首次永久遗忘登记时间，重复遗忘不改写'")


def downgrade():
    raise RuntimeError("Permanent forgetting must not be undone by dropping identity tombstones")
