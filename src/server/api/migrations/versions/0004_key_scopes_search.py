"""Scoped keys and PostgreSQL lexical index for bounded hybrid retrieval."""
from alembic import op

revision = "0004_key_scopes_search"
down_revision = "0003_profile_history"
branch_labels = depends_on = None


def upgrade():
    op.execute("""CREATE TABLE project_api_keys (
        id UUID PRIMARY KEY, project_id VARCHAR(64) NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
        name VARCHAR(128) NOT NULL, token_hash VARCHAR(64) NOT NULL, scopes JSONB NOT NULL,
        expires_at TIMESTAMPTZ, revoked_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CHECK (jsonb_array_length(scopes) BETWEEN 1 AND 3),
        CHECK (scopes <@ '["read", "write", "admin"]'::jsonb)
    )""")
    op.execute("CREATE INDEX idx_project_api_keys_project ON project_api_keys(project_id, id)")
    op.execute("CREATE INDEX idx_user_events_lexical ON user_events USING gin(to_tsvector('simple', coalesce(event_data->>'event_tip', '')))")
    op.execute("COMMENT ON TABLE project_api_keys IS '项目级 API key，仅保存摘要，逐请求检查撤销、过期及权限'")


def downgrade():
    raise RuntimeError("Data-bearing migrations require an explicit maintenance recovery")
