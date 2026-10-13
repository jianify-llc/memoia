"""Retire obsolete Gist indexes; preserve Event bodies and evidence-backed Facts."""
from alembic import op

revision = "0011_retire_gists"
down_revision = "0010_historical_facts"
branch_labels = None
depends_on = None


def upgrade():
    # No conversion: legacy Gists cannot manufacture external message evidence.
    op.drop_table("user_event_gists")
    # jsonb_ops supports ?| for exact message membership; jsonb_path_ops does not.
    op.create_index("idx_memory_blobs_message_ids", "memory_blobs", ["message_ids"], postgresql_using="gin")


def downgrade():
    raise RuntimeError("Downgrade unsupported; use a forward migration for further changes. "
                       "Deleted Gist contents require an approved backup to restore")
