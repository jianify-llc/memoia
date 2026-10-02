"""Sources, evidence and durable operation receipts; no destructive data rewrite."""
from pathlib import Path
from alembic import op

revision = "0002_sources_v2"
down_revision = "0001_v1_baseline"
branch_labels = None
depends_on = None


def upgrade():
    sql = (Path(__file__).parents[1] / "sources-v2.sql").read_text()
    for statement in sql.split(";"):
        if statement.strip():
            op.execute(statement)
    op.execute("ALTER TABLE memory_sources ADD CONSTRAINT memory_sources_status_check CHECK (status IN ('active','retracted','rebuilding'))")
    op.execute("ALTER TABLE memory_operations ADD CONSTRAINT memory_operations_status_check CHECK (status IN ('processing','completed','failed'))")
    op.execute("ALTER TABLE memory_operations ADD CONSTRAINT memory_operations_kind_check CHECK (kind IN ('import','retract'))")
    op.execute("ALTER TABLE memory_operations ADD CONSTRAINT memory_operations_completion_check CHECK ((status != 'completed' OR (source_id IS NOT NULL AND result IS NOT NULL AND error IS NULL)) AND (status != 'failed' OR error IS NOT NULL))")


def downgrade():
    raise RuntimeError("Do not delete retained sources/receipts to roll back the application; use a compatible image")
