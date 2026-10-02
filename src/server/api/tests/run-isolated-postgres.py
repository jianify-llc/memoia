"""Local integration runner: borrow a server, never its existing database/data."""
import json
import os
import subprocess
import sys
from urllib.parse import quote
from uuid import uuid4

import psycopg2
from psycopg2 import sql

postgres_name = "memoia-goal-regression-20260926-postgres-1"
redis_name = "memoia-goal-regression-20260926-redis-1"
postgres = json.loads(subprocess.check_output(["docker", "inspect", postgres_name]))[0]
redis = json.loads(subprocess.check_output(["docker", "inspect", redis_name]))[0]
values = dict(item.split("=", 1) for item in postgres["Config"]["Env"] if "=" in item)
user, password = values["POSTGRES_USER"], values["POSTGRES_PASSWORD"]
cmd = redis["Config"]["Cmd"]
redis_password = cmd[cmd.index("--requirepass") + 1] if "--requirepass" in cmd else None
name = "memoia_v2_core_" + uuid4().hex[:12]
connection = psycopg2.connect(host="127.0.0.1", port=63689, user=user, password=password, dbname="postgres")
connection.autocommit = True
with connection.cursor() as cursor:
    cursor.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(name)))
env = dict(os.environ)
env.update(DATABASE_URL=f"postgresql://{quote(user, safe='')}:{quote(password, safe='')}@127.0.0.1:63689/{name}",
           REDIS_URL="redis://" + (":" + quote(redis_password, safe="") + "@" if redis_password else "") + "127.0.0.1:63688/9",
           ACCESS_TOKEN="isolated-test-not-a-production-token", PROJECT_ID=name,
           MEMOBASE_LLM_API_KEY="isolated-test-not-a-provider-key", MEMOBASE_EMBEDDING_API_KEY="isolated-test-not-a-provider-key")
try:
    subprocess.run([sys.executable, "-m", "alembic", "upgrade", "head"], env=env, check=True)
    subprocess.run([sys.executable, "-c", "from memoia_server.schema import check_schema; check_schema()"], env=env, check=True)
    result = subprocess.run([sys.executable, "-m", "pytest", *(sys.argv[1:] or ["tests", "-q"])], env=env)
finally:
    with connection.cursor() as cursor:
        cursor.execute(sql.SQL("DROP DATABASE {} WITH (FORCE)").format(sql.Identifier(name)))
    connection.close()
sys.exit(result.returncode)
