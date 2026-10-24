"""Rename the Event narrative time field without changing its value or identity."""
from alembic import op

revision = "0015_event_time"
down_revision = "0014_fact_time"
branch_labels = None
depends_on = None


def upgrade():
    op.execute("""
        DO $$
        BEGIN
          IF EXISTS (SELECT 1 FROM user_events
            WHERE jsonb_typeof(event_data)='object'
              AND event_data ? 'time' AND event_data ? 'event_time'
              AND event_data->'time' IS DISTINCT FROM event_data->'event_time') THEN
            RAISE EXCEPTION 'Event time and event_time conflict; resolve values before migration';
          END IF;
        END $$;

        UPDATE user_events
          SET event_data=(event_data - 'time') || jsonb_build_object('event_time', event_data->'time')
          WHERE jsonb_typeof(event_data)='object' AND event_data ? 'time';
    """)


def downgrade():
    raise RuntimeError("Event time requires a forward migration")
