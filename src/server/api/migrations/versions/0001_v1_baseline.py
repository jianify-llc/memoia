"""Frozen v1 baseline with strict non-destructive adoption of the existing schema."""
import json
import re
from pathlib import Path

from alembic import op
from sqlalchemy import inspect
from sqlalchemy.dialects import postgresql

revision = "0001_v1_baseline"
down_revision = None
branch_labels = None
depends_on = None


def upgrade():
    from memoia_server.env import CONFIG
    root = Path(__file__).parents[1]
    contract = json.loads((root / "baseline-v1.json").read_text())
    baseline_sql = (root / "baseline-v1.sql").read_text()
    connection = op.get_bind()
    inspector = inspect(connection)
    schema = inspector.default_schema_name
    present = set(inspector.get_table_names(schema=schema)) & set(contract)
    if present and present != set(contract):
        raise RuntimeError("Incomplete v1 schema; manual repair is required before adoption")
    if present:
        for table_name, table in contract.items():
            actual_columns = {c["name"]: c for c in inspector.get_columns(table_name, schema=schema)}
            actual = {name: str(c["type"].compile(dialect=postgresql.dialect())) for name, c in actual_columns.items()}
            expected = {name: (f"VECTOR({CONFIG.embedding_dim})" if type_name.startswith("VECTOR(") else type_name)
                        for name, type_name in table["columns"].items()}
            if set(actual) != set(expected) or any(actual.get(name) != type_name for name, type_name in expected.items()):
                raise RuntimeError(f"v1 column contract mismatch: {table_name}")
            table_sql = re.search(rf"CREATE TABLE {re.escape(table_name)} \((.*?)\n\)\s*;", baseline_sql, re.S).group(1)
            for name in expected:
                required = bool(re.search(rf"^\s*{re.escape(name)}\s+[^\n]*\bNOT NULL\b", table_sql, re.M))
                if actual_columns[name]["nullable"] == required:
                    raise RuntimeError(f"v1 nullability contract mismatch: {table_name}.{name}")
                if re.search(rf"^\s*{re.escape(name)}\s+[^\n]*\bDEFAULT now\(\)", table_sql, re.M):
                    if actual_columns[name]["default"] != "now()":
                        raise RuntimeError(f"v1 default contract mismatch: {table_name}.{name}")
            if inspector.get_pk_constraint(table_name, schema=schema)["constrained_columns"] != table["primary_key"]:
                raise RuntimeError(f"v1 primary-key contract mismatch: {table_name}")
            actual_fks = inspector.get_foreign_keys(table_name, schema=schema)
            for expected_fk in table["foreign_keys"]:
                if not any(fk["constrained_columns"] == expected_fk["columns"] and
                           fk["referred_table"] == expected_fk["table"] and
                           fk["referred_columns"] == expected_fk["references"] and
                           fk["referred_schema"] in {None, schema} and
                           fk["options"].get("ondelete") == expected_fk["ondelete"] and
                           fk["options"].get("onupdate") == expected_fk["onupdate"] for fk in actual_fks):
                    raise RuntimeError(f"v1 foreign-key contract mismatch: {table_name}")
            existing_indexes = {idx["name"]: idx["column_names"] for idx in inspector.get_indexes(table_name, schema=schema)}
            for match in re.finditer(rf"CREATE INDEX (\w+) ON {re.escape(table_name)} \(([^)]+)\)", baseline_sql):
                if existing_indexes.get(match.group(1)) != match.group(2).split(", "):
                    raise RuntimeError(f"v1 index contract mismatch: {table_name}.{match.group(1)}")
        return
    op.execute("CREATE EXTENSION IF NOT EXISTS vector")
    sql = baseline_sql.replace("__EMBEDDING_DIM__", str(int(CONFIG.embedding_dim)))
    for statement in sql.split(";"):
        if statement.strip():
            op.execute(statement)


def downgrade():
    raise RuntimeError("Baseline adoption is not reversible by dropping live tables; restore an isolated backup")
