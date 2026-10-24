"""Historical 0013 guard remains in the forward chain without runtime mode writes."""
import json
from pathlib import Path
from uuid import uuid4
from alembic import command
from alembic.config import Config
import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from tests.test_schema_adoption import legacy_schema


def test_one_mode_freeze_with_immutable_flush_identity(legacy_schema, monkeypatch):
    engine, url = legacy_schema
    monkeypatch.setenv("DATABASE_URL", url)
    config = Config()
    config.set_main_option("script_location", str(Path(__file__).parents[1] / "migrations"))
    command.upgrade(config, "0012_fact_corrections")
    uid, ident = uuid4(), uuid4()
    with engine.begin() as db:
        db.execute(text("INSERT INTO projects(id,project_id,project_secret,status) VALUES(:id,'mode','fixture','active')"), {"id": uuid4()})
        db.execute(text("INSERT INTO users(id,project_id) VALUES(:id,'mode')"), {"id": uid})
        db.execute(text("""INSERT INTO memory_operations(id,user_id,project_id,idempotency_key,kind,
          request_hash,request,status) VALUES(:id,:uid,'mode',:key,'flush',repeat('a',64),
          '{"blob_ids":[]}', 'processing')"""), {"id": ident, "uid": uid, "key": str(ident)})
    command.upgrade(config, "head")
    def write(payload, **changes):
        assignments = ', '.join(f'{key}=:{key}' for key in changes)
        with engine.begin() as db:
            db.execute(text("UPDATE memory_operations SET request=CAST(:request AS jsonb)" +
                (", " + assignments if assignments else "") + " WHERE id=:id"),
                {"id": ident, "request": json.dumps(payload), **changes})
    for mode in ("plus", None, 1, {"mode": "pro"}):
        with pytest.raises(IntegrityError):
            write({"blob_ids": [], "reasoning_mode": mode})
    write({"blob_ids": [], "reasoning_mode": "pro"})
    write({"blob_ids": [], "reasoning_mode": "pro"})
    for payload in ({"blob_ids": [], "reasoning_mode": "standard"}, {"blob_ids": []},
                    {"blob_ids": [str(uuid4())], "reasoning_mode": "pro"}):
        with pytest.raises(IntegrityError):
            write(payload)
    for changes in ({"request_hash": "b" * 64}, {"idempotency_key": "rewritten"}, {"kind": "import"}):
        with pytest.raises(IntegrityError):
            write({"blob_ids": [], "reasoning_mode": "pro"}, **changes)
