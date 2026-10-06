#!/usr/bin/env bash
set -euo pipefail

image=${1:?manifest-addressed Memoia image}
[[ "$image" =~ ^ghcr\.io/(jianify|jianify-llc)/memoia@sha256:[0-9a-f]{64}$ ]] || exit 2
# 只读取镜像中的建表/ORM/迁移源码，不导入应用、不连接 DB，也不注入任何配置。
docker run --rm --network none --entrypoint /app/.venv/bin/python "$image" -c '
import hashlib
from pathlib import Path
root = Path("/app")
files = [root / "memoia_server/models/database.py", root / "memoia_server/connectors.py"]
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
'
