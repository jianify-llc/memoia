"""Rename Fact time and its known recovery fields without changing identity."""
from alembic import op

revision = "0014_fact_time"
down_revision = "0013_reasoning_mode"
branch_labels = None
depends_on = None


def upgrade():
    op.execute("""
        ALTER TABLE memory_facts RENAME COLUMN event_time TO fact_time;
        COMMENT ON COLUMN memory_facts.fact_time IS
          '事实发生日期范围、精度与原始时间证据；不是消息记录时间，旧记录不推测回填';

        UPDATE memory_operations
          SET request=(request - 'event_time') || jsonb_build_object('fact_time', request->'event_time')
          WHERE kind='correct' AND status!='completed' AND request ? 'event_time';

        UPDATE memory_operations o SET request=jsonb_set(o.request,
          '{fact_review_candidate,extraction,facts}', (
            SELECT jsonb_agg(CASE WHEN fact ? 'event_time'
              THEN (fact - 'event_time') || jsonb_build_object('fact_time', fact->'event_time')
              ELSE fact END ORDER BY ordinal)
            FROM jsonb_array_elements(o.request #> '{fact_review_candidate,extraction,facts}')
              WITH ORDINALITY AS saved(fact, ordinal)))
          WHERE o.kind='import' AND o.status!='completed'
            AND jsonb_typeof(o.request #> '{fact_review_candidate,extraction,facts}')='array'
            AND EXISTS (SELECT 1
              FROM jsonb_array_elements(o.request #> '{fact_review_candidate,extraction,facts}') AS saved(fact)
              WHERE fact ? 'event_time');
    """)


def downgrade():
    raise RuntimeError("Fact time and recovery identities require a forward migration")
