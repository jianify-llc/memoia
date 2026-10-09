#!/usr/bin/env bash
set -euo pipefail

image=${1:?manifest-addressed Memoia image}
format=${2:-schema}
[[ "$image" =~ ^ghcr\.io/(jianify|jianify-llc)/memoia@sha256:[0-9a-f]{64}$ ]] || exit 2
[[ "$format" == schema || "$format" == legacy ]] || exit 2
# Alembic/ORM owns schema; connection pools and Redis settings are runtime code.
# Legacy is only for verifying an already accepted baseline during format transition.
docker run --rm --network none --entrypoint /app/.venv/bin/python "$image" -c '
import hashlib
import sys
from pathlib import Path
root = Path("/app")
files = [root / "memoia_server/models/database.py"]
if sys.argv[1] == "legacy":
    files.append(root / "memoia_server/connectors.py")
files += [p for p in (root / "memoia_server/models/source.py", root / "memoia_server/models/projects.py",
                      root / "alembic.ini") if p.is_file()]
migrations = root / "migrations"
if not migrations.is_dir():
    raise SystemExit("Image does not include migration source")
files += sorted(p for p in migrations.rglob("*") if p.is_file() and "__pycache__" not in p.parts)
digest = hashlib.sha256()
for file in files:
    digest.update(str(file.relative_to(root)).encode() + b"\0" + file.read_bytes() + b"\0")
print(digest.hexdigest())
' "$format"
