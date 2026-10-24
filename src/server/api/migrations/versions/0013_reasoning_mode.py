"""Freeze the maintenance execution mode once without changing flush identity."""
from alembic import op

revision = "0013_reasoning_mode"
down_revision = "0012_fact_corrections"
branch_labels = None
depends_on = None


def upgrade():
    op.execute("""
        CREATE OR REPLACE FUNCTION guard_memory_flush_request() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF OLD.kind='flush' THEN
            IF NEW.kind IS DISTINCT FROM OLD.kind OR NEW.request_hash IS DISTINCT FROM OLD.request_hash
              OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
              OR (NEW.request - 'reasoning_mode') IS DISTINCT FROM (OLD.request - 'reasoning_mode') THEN
              RAISE EXCEPTION 'fixed flush identity is immutable' USING ERRCODE='23514';
            END IF;
            IF NEW.request IS DISTINCT FROM OLD.request AND NOT COALESCE(
              NOT (OLD.request ? 'reasoning_mode')
                AND NEW.request ->> 'reasoning_mode' IN ('standard', 'pro'), false) THEN
              RAISE EXCEPTION 'frozen flush reasoning mode is immutable' USING ERRCODE='23514';
            END IF;
          END IF;
          RETURN NEW;
        END $$;
        COMMENT ON FUNCTION guard_memory_flush_request() IS
          '固定派生批次身份不可变；首次执行允许写入推理模式，冻结后不可变';
    """)


def downgrade():
    raise RuntimeError("Execution modes are durable recovery data; use a forward migration")
