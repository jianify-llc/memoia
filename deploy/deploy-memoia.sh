#!/usr/bin/env bash
set -euo pipefail

# 日常发布配置只读；init-config 仅补缺失模板与权限，绝不覆盖已有值。
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
[[ "$EUID" == 0 ]] || { echo 'Run with sudo -n' >&2; exit 2; }
mode=${1:?init-config, init, prepare, finalize, migrate-schema, finalize-schema, restore-api, adopt-external-postgres, backup or restore-data}
root=${2:?deployment root}

[[ "$root" == /opt/memoia ]] || {
  echo 'Unexpected deployment root' >&2
  exit 2
}
if [[ "$mode" == init-config ]]; then
  # 初始化只生成缺失的模板/目录，不启动容器，也不覆盖操作员已填的值。
  exec 8>/run/lock/memoia-config-init.lock
  flock -n 8 || { echo 'Another config initialization is running' >&2; exit 1; }
  for directory in "$root" "$root/api"; do
    [[ ! -L "$directory" && ( ! -e "$directory" || -d "$directory" ) ]] || exit 2
    if [[ ! -d "$directory" || "$(stat -c '%u:%g:%a' "$directory")" != 0:0:700 ]]; then
      install -d -o root -g root -m 700 "$directory"
    fi
  done
  for mapping in '.env.example:.env:600' 'config.yaml.example:api/config.yaml:600' 'docker-compose.yml:docker-compose.yml:644'; do
    IFS=: read -r template destination permissions <<< "$mapping"
    file="$root/$destination"
    [[ ! -L "$file" && ( ! -e "$file" || -f "$file" ) ]] || exit 2
    if [[ ! -e "$file" ]]; then
      install -o root -g root -m "$permissions" "$script_dir/$template" "$file"
    elif [[ "$(stat -c '%u:%g:%a' "$file")" != "0:0:$permissions" ]]; then
      chown root:root "$file"
      chmod "$permissions" "$file"
    fi
  done
  # 不递归 chown；历史 PostgreSQL 数据由迁移手册处理，不能自动改动。
  for directory in "$root/data" "$root/data/redis"; do
    [[ ! -L "$directory" && ( ! -e "$directory" || -d "$directory" ) ]] || exit 2
    if [[ ! -e "$directory" ]]; then install -d -o root -g root -m 700 "$directory"; fi
  done
  echo 'Config templates prepared; fill blank values before installation. No services started.'
  exit 0
fi
if [[ "$mode" == backup || "$mode" == restore-data ]]; then
  exec python3 "$script_dir/recovery.py" "$@"
fi
image=${3:?manifest-addressed image}
source_sha=${4:?source commit}
run_id=${5:?GitHub run ID}
compose_sha=${6:?compose SHA-256}
[[ "$image" =~ ^ghcr\.io/jianify/memoia@sha256:[0-9a-f]{64}$ ]] || exit 2
[[ "$source_sha" =~ ^[0-9a-f]{40}$ ]] || exit 2
[[ "$run_id" =~ ^[0-9]+$ ]] || exit 2
[[ "$compose_sha" =~ ^[0-9a-f]{64}$ ]] || exit 2
[[ "$mode" == init || "$mode" == prepare || "$mode" == finalize || "$mode" == migrate-schema || "$mode" == finalize-schema || "$mode" == restore-api || "$mode" == adopt-external-postgres ]] || exit 2
export MEMOIA_IMAGE="$image"

[[ -d "$root" && ! -L "$root" && "$(stat -c '%u:%g:%a' "$root")" == 0:0:700 ]] || exit 2
[[ -d "$root/api" && ! -L "$root/api" && "$(stat -c '%u:%g:%a' "$root/api")" == 0:0:700 ]] || exit 2
[[ -f "$root/.env" && -f "$root/api/config.yaml" && -f "$root/docker-compose.yml" ]] || {
  echo 'First installation is not complete' >&2
  exit 1
}
for file in "$root/.env" "$root/api/config.yaml"; do
  [[ ! -L "$file" && "$(stat -c '%u:%g:%a' "$file")" == 0:0:600 ]] || {
    echo 'Managed config must be root:root 0600; fix manually' >&2; exit 1;
  }
done
[[ ! -L "$root/docker-compose.yml" && "$(stat -c '%u:%g:%a' "$root/docker-compose.yml")" == 0:0:644 ]] || exit 2
compose=(docker compose --env-file "$root/.env" -f "$root/docker-compose.yml")
"${compose[@]}" config --quiet
resolved=$("${compose[@]}" config --format json)
deployment_env=$(jq -r '.services.memoia.labels["io.jianify.environment"]' <<< "$resolved")
[[ "$deployment_env" == test || "$deployment_env" == online ]] || {
  echo 'Memoia deployment environment must be test or online' >&2; exit 2;
}
[[ "$(jq -r .name <<< "$resolved")" == "memoia-$deployment_env" ]] || {
  echo 'Compose project does not match the application environment' >&2; exit 2;
}
if [[ "$mode" == migrate-schema || "$mode" == finalize-schema ]]; then
  [[ "$deployment_env" == test ]] || { echo 'Schema maintenance is test-only in this release' >&2; exit 2; }
  evidence_file=${7:?protected maintenance evidence file}
fi
[[ "$(jq -r '.services.redis.volumes[0].source' <<< "$resolved")" == "$root/data/redis" ]] || {
  echo 'Resolved data mount differs from the canonical absolute path' >&2; exit 1;
}
python3 -c '
import json, sys
from urllib.parse import unquote, urlsplit
c = json.load(sys.stdin)["services"]
pg = urlsplit(c["memoia"]["environment"]["DATABASE_URL"])
redis = urlsplit(c["memoia"]["environment"]["REDIS_URL"])
valid = (pg.scheme == "postgresql" and pg.hostname == "jianify-postgres" and (pg.port or 5432) == 5432
         and pg.path == "/memoia" and unquote(pg.username or "") == "jianify_app"
         and bool(unquote(pg.password or "")) and not pg.query and not pg.fragment
         and redis.hostname == "redis" and (redis.port or 6379) == 6379
         and redis.path == "/0"
         and unquote(redis.password or "") == c["redis"]["environment"]["REDIS_PASSWORD"])
if not valid:
    sys.exit("API connections must use the company Memoia database and local Redis")
' <<< "$resolved"
[[ "$(jq -r '.networks.data.name' <<< "$resolved")" == jianify-data && "$(jq -r '.networks.data.external' <<< "$resolved")" == true ]] || {
  echo 'Company PostgreSQL network is not the fixed external jianify-data network' >&2; exit 1;
}
[[ "$(sha256sum "$root/docker-compose.yml" | cut -d' ' -f1)" == "$compose_sha" ]] || {
  echo 'Compose changed; use the separate infrastructure maintenance procedure' >&2
  exit 1
}
state_dir="$root/.deploy"
[[ ! -L "$state_dir" ]] || exit 2
if [[ ! -d "$state_dir" ]]; then install -d -o root -g root -m 700 "$state_dir"; fi
[[ "$(stat -c '%u:%g:%a' "$state_dir")" == 0:0:700 ]] || exit 2
umask 077
cd "$state_dir"
exec 9> .deploy.lock
flock -x 9
postgres_status=$(python3 /opt/postgres/postgresctl.py status)
[[ "$(jq -r '.healthy' <<< "$postgres_status")" == true &&
   "$(jq -r '.mount' <<< "$postgres_status")" == /opt/postgres/data &&
   "$(jq -r '.network' <<< "$postgres_status")" == jianify-data &&
   -n "$(jq -r '.container_id' <<< "$postgres_status")" ]] || {
  echo 'Company PostgreSQL is not the expected healthy private instance' >&2; exit 1;
}
postgres_container=$(jq -r '.container_id' <<< "$postgres_status")
[[ -f "$script_dir/infra-fingerprint.sh" && -f "$script_dir/schema-fingerprint.sh" ]] || exit 2
if [[ "$mode" != init && "$mode" != adopt-external-postgres ]]; then
[[ -f infra-config.sha256 && -f schema.sha256 ]] || {
  echo 'Infrastructure baseline is missing' >&2
  exit 1
}
[[ "$(bash "$script_dir/infra-fingerprint.sh" "$root")" == "$(sed -n '1p' infra-config.sha256)" ]] || {
  echo 'Infrastructure configuration changed; use separate maintenance' >&2
  exit 1
}
fi

config_sha=$(sha256sum "$root/.env" "$root/api/config.yaml" | sha256sum | cut -d' ' -f1)
tunnel_ready() {
  systemctl is-active --quiet jianify-cloudflared.service &&
    curl -fsS --max-time 5 http://127.0.0.1:20241/ready >/dev/null &&
    curl -fsS --max-time 5 http://127.0.0.1:20241/metrics |
    awk '/^cloudflared_tunnel_ha_connections(\{[^}]*\})?[[:space:]]/ {found=1; connections+=$NF} END {exit !(found && connections>0)}'
}
api_database_matches() {
  [[ "$(docker inspect "$1" | jq -r '.[0].Config.Env[] | select(startswith("DATABASE_URL=")) | sub("^DATABASE_URL=";"")')" == "$(jq -r '.services.memoia.environment.DATABASE_URL' <<< "$resolved")" ]]
}

if [[ "$mode" == finalize || "$mode" == finalize-schema ]]; then
  if [[ "$mode" == finalize ]]; then
    [[ ! -e pending-maintenance ]] || { echo 'Schema maintenance requires finalize-schema, not ordinary finalize' >&2; exit 1; }
  else
    python3 "$script_dir/schema-maintenance.py" finalize "$root" "$image" "$source_sha" "$run_id" "$evidence_file"
    "${compose[@]}" exec -T memoia /app/.venv/bin/python -c 'from memoia_server.schema import check_schema; check_schema()'
    [[ "$(bash "$script_dir/schema-fingerprint.sh" "$image")" == "$(< pending-schema.sha256)" ]] || {
      echo 'Candidate schema differs from pending maintenance' >&2; exit 1;
    }
  fi
  [[ -f pending-deploy ]] || { echo 'No pending deployment' >&2; exit 1; }
  [[ "$(sed -n '1p' pending-deploy)" == "$run_id $source_sha $image $config_sha" ]] || {
    echo 'Pending deployment identity mismatch' >&2
    exit 1
  }
  container=$("${compose[@]}" ps -q memoia)
  [[ -n "$container" && "$(docker inspect --format '{{.Config.Image}}' "$container")" == "$image" ]] || {
    echo 'Running API image does not match candidate' >&2
    exit 1
  }
  [[ "$(docker inspect --format '{{.State.Health.Status}}' "$container")" == healthy ]] || {
    echo 'Candidate API is not healthy' >&2
    exit 1
  }
  [[ "$(docker inspect --format '{{.State.OOMKilled}} {{.RestartCount}}' "$container")" == 'false 0' ]] || {
    echo 'Candidate OOM or automatic restart blocks acceptance' >&2; exit 1;
  }
  api_database_matches "$container" || { echo 'Candidate database connection differs from the fixed configuration' >&2; exit 1; }
  [[ "$postgres_container" == "$(sed -n '/^postgres /s/^postgres //p' pending-infra)" ]] || {
    echo 'Company PostgreSQL changed during API deployment' >&2; exit 1;
  }
  [[ "$("${compose[@]}" ps -q redis)" == "$(sed -n '/^redis /s/^redis //p' pending-infra)" ]] || {
    echo 'Redis changed during API deployment' >&2; exit 1;
  }
  [[ "$(systemctl show jianify-cloudflared.service -p MainPID -p ActiveEnterTimestamp)" == "$(< pending-tunnel)" ]] || {
    echo 'Host Tunnel changed during deployment' >&2; exit 1;
  }
  tunnel_ready || { echo 'Host Tunnel is not connected' >&2; exit 1; }
  state_tmp=$(mktemp "$state_dir/.deploy-state.XXXXXX")
  # 恢复旧 API 也不降低 run 高水位；同版本重验不覆盖真正的上一版本。
  high_water=$run_id
  if [[ -f deploy-state ]]; then
    previous_run=$(cut -d' ' -f1 deploy-state)
    (( previous_run <= high_water )) || high_water=$previous_run
    if [[ "$mode" != finalize-schema && "$(cut -d' ' -f3 deploy-state)" != "$image" ]]; then cp deploy-state previous-accepted; fi
  fi
  install -d -m 700 accepted
  printf '%s %s %s %s %s\n' "$run_id" "$source_sha" "$image" "$compose_sha" "$config_sha" > "$state_tmp"
  cp "$state_tmp" "accepted/$source_sha"
  printf '%s %s %s %s %s\n' "$high_water" "$source_sha" "$image" "$compose_sha" "$config_sha" > "$state_tmp"
  mv "$state_tmp" deploy-state
  if [[ "$mode" == finalize-schema ]]; then
    mv pending-schema.sha256 schema.sha256
    # 已变更 schema 的旧镜像仅留诊断归档，不再授予普通 API 恢复资格。
    rm -f previous-accepted
    cp "$evidence_file" "schema-archives/$run_id/business-accepted.json"
    rm pending-maintenance
  fi
  rm pending-deploy pending-infra pending-tunnel
  exit 0
fi

[[ ! -e pending-deploy ]] || {
  echo 'Previous deployment has an unresolved result; operator review required' >&2
  exit 1
}
[[ ! -e pending-maintenance ]] || { echo 'Unresolved maintenance blocks deployment' >&2; exit 1; }
if [[ "$mode" == adopt-external-postgres ]]; then
  # 只在数据库切换、应用验收之后显式接纳新基础设施基线，普通发布不执行此路径。
  [[ "$deployment_env" == test ]] || { echo 'PostgreSQL adoption is a test-only migration' >&2; exit 2; }
  [[ -f deploy-state && -f infra-config.sha256 && -f schema.sha256 && ! -e pre-external-postgres &&
     ! -e pending-infra && ! -e pending-tunnel ]] || {
    echo 'Existing accepted deployment and an unused adoption record are required' >&2; exit 1;
  }
  read -r accepted_run accepted_sha accepted_image _old_compose _old_config < deploy-state
  [[ "$run_id" == "$accepted_run" && "$source_sha" == "$accepted_sha" && "$image" == "$accepted_image" ]] || {
    echo 'Adoption must target the current accepted API identity' >&2; exit 1;
  }
  [[ "$_old_compose" != "$compose_sha" && "$_old_config" != "$config_sha" ]] || {
    echo 'Adoption requires the reviewed Compose and connection change' >&2; exit 1;
  }
  [[ -z "$(docker ps --filter label=com.docker.compose.project=memoia-test --filter label=com.docker.compose.service=postgres --format '{{.ID}}')" ]] || {
    echo 'The old Memoia PostgreSQL container is still running' >&2; exit 1;
  }
  next_infra=$(bash "$script_dir/infra-fingerprint.sh" "$root")
  [[ "$next_infra" != "$(< infra-config.sha256)" ]] || {
    echo 'No infrastructure change to adopt' >&2; exit 1;
  }
  [[ "$(bash "$script_dir/schema-fingerprint.sh" "$image")" == "$(< schema.sha256)" ]] || {
    echo 'Schema identity changed; this is not a PostgreSQL-only migration' >&2; exit 1;
  }
  api_container=$("${compose[@]}" ps -q memoia)
  redis_container=$("${compose[@]}" ps -q redis)
  [[ -n "$api_container" && -n "$redis_container" ]] || { echo 'API or Redis is not running' >&2; exit 1; }
  [[ "$(docker inspect --format '{{.Config.Image}}' "$api_container")" == "$image" &&
     "$(docker inspect --format '{{.State.Health.Status}}' "$api_container")" == healthy &&
     "$(docker inspect --format '{{.State.OOMKilled}} {{.RestartCount}}' "$api_container")" == 'false 0' ]] || {
    echo 'Accepted API image must be healthy without restart' >&2; exit 1;
  }
  api_database_matches "$api_container" || {
    echo 'Running API is not connected with the new database configuration' >&2; exit 1;
  }
  [[ "$(docker inspect --format '{{.Config.Image}}' "$redis_container")" == "$(jq -r '.services.redis.image' <<< "$resolved")" &&
     "$(docker inspect --format '{{.State.Health.Status}}' "$redis_container")" == healthy &&
     "$(docker inspect "$redis_container" | jq -r '.[0].Mounts[] | select(.Destination == "/data") | .Source')" == "$root/data/redis" ]] || {
    echo 'Redis differs from the fixed application deployment' >&2; exit 1;
  }
  [[ "$(docker exec "$postgres_container" psql -U jianify_app -d memoia -Atc "SELECT count(*) FROM pg_tables WHERE schemaname='public'")" =~ ^[1-9][0-9]*$ &&
     "$(docker exec "$postgres_container" psql -U jianify_app -d memoia -Atc "SELECT count(*) FROM pg_extension WHERE extname='vector'")" == 1 ]] || {
    echo 'Migrated Memoia tables or vector extension are missing' >&2; exit 1;
  }
  tunnel_ready || { echo 'Host Tunnel is not connected' >&2; exit 1; }
  final_postgres_status=$(python3 /opt/postgres/postgresctl.py status)
  [[ "$(jq -r '.container_id' <<< "$final_postgres_status")" == "$postgres_container" &&
     "$(jq -r '.fingerprint' <<< "$final_postgres_status")" == "$(jq -r '.fingerprint' <<< "$postgres_status")" ]] || {
    echo 'Company PostgreSQL changed during adoption verification' >&2; exit 1;
  }
  printf 'adopt-external-postgres %s\n' "$run_id" > pending-maintenance
  cp deploy-state pre-external-postgres
  [[ ! -f previous-accepted ]] || cp previous-accepted pre-external-postgres-previous
  baseline_tmp=$(mktemp "$state_dir/.infra-config.XXXXXX")
  state_tmp=$(mktemp "$state_dir/.deploy-state.XXXXXX")
  printf '%s\n' "$next_infra" > "$baseline_tmp"
  printf '%s %s %s %s %s\n' "$run_id" "$source_sha" "$image" "$compose_sha" "$config_sha" > "$state_tmp"
  mv "$baseline_tmp" infra-config.sha256
  install -d -m 700 accepted
  cp "$state_tmp" "accepted/$source_sha"
  mv "$state_tmp" deploy-state
  rm -f previous-accepted
  rm pending-maintenance
  echo 'External PostgreSQL baseline adopted; previous API recovery target requires new compatibility acceptance.'
  exit 0
fi
if [[ -f deploy-state && "$mode" != restore-api && "$mode" != adopt-external-postgres ]]; then
  previous_run=$(cut -d' ' -f1 deploy-state)
  (( run_id > previous_run )) || {
    echo 'Stale or repeated workflow run; use an explicit recovery procedure' >&2
    exit 1
  }
fi
if [[ "$mode" != restore-api && "$mode" != adopt-external-postgres ]]; then
branch=$deployment_env
[[ "$deployment_env" != online ]] || branch=release
head_sha=$(curl -fsSL --max-time 15 "https://api.github.com/repos/jianify/memoia/git/ref/heads/$branch" | jq -r .object.sha)
[[ "$head_sha" == "$source_sha" ]] || {
  echo "A newer $branch branch head exists; refusing stale deployment" >&2
  exit 1
}
else
  [[ -f previous-accepted && -f "accepted/$source_sha" ]] || { echo 'No accepted previous version' >&2; exit 1; }
  [[ "$(cut -d' ' -f2-5 previous-accepted)" == "$source_sha $image $compose_sha $config_sha" ]] || {
    echo 'Recovery target or configuration is not the accepted previous version' >&2; exit 1;
  }
fi

tunnel_ready || { echo 'Host Tunnel is not connected' >&2; exit 1; }
# 拉取失败发生在停机之前；源码指纹读取不导入应用、不触碰数据库。
MEMOIA_IMAGE="$image" "${compose[@]}" pull memoia
revision=$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image")
[[ "$revision" == "$source_sha" ]] || { echo 'Image revision mismatch' >&2; exit 1; }
schema_sha=$(bash "$script_dir/schema-fingerprint.sh" "$image")
[[ "$schema_sha" =~ ^[0-9a-f]{64}$ ]] || exit 1
if [[ "$mode" == init ]]; then
  [[ ! -e deploy-state && ! -e infra-config.sha256 && ! -e schema.sha256 ]] || { echo 'Initialization already recorded' >&2; exit 1; }
  for service in redis memoia; do
    [[ -z "$("${compose[@]}" ps -aq "$service")" ]] || { echo 'Existing stack blocks initialization' >&2; exit 1; }
  done
  directory="$root/data/redis"
  [[ -d "$directory" && ! -L "$directory" && -z "$(find "$directory" -mindepth 1 -print -quit)" ]] || {
    echo 'First installation requires empty, fixed data directories' >&2; exit 1;
  }
  [[ "$(docker exec "$postgres_container" psql -U jianify_app -d memoia -Atc "SELECT count(*) FROM pg_tables WHERE schemaname='public'")" == 0 ]] || {
    echo 'First installation requires an empty company Memoia database' >&2; exit 1;
  }
  tunnel_ready || { echo 'Host Tunnel is not connected' >&2; exit 1; }
  bash "$script_dir/infra-fingerprint.sh" "$root" > infra-config.sha256
  printf '%s\n' "$schema_sha" > schema.sha256
  printf '%s %s %s %s\n' "$run_id" "$source_sha" "$image" "$config_sha" > pending-deploy
  systemctl show jianify-cloudflared.service -p MainPID -p ActiveEnterTimestamp > pending-tunnel
  MEMOIA_IMAGE="$image" "${compose[@]}" up -d --no-build redis
  "${compose[@]}" run --rm --no-deps --entrypoint /app/.venv/bin/python memoia -m alembic upgrade head
  "${compose[@]}" run --rm --no-deps --entrypoint /app/.venv/bin/python memoia -c 'from memoia_server.schema import check_schema; check_schema()'
  MEMOIA_IMAGE="$image" "${compose[@]}" up -d --no-deps --no-build memoia
  printf 'postgres %s\nredis %s\n' "$postgres_container" "$("${compose[@]}" ps -q redis)" > pending-infra
  echo 'First stack started; business acceptance is required before finalize. Automatic updates remain disabled.'
  exit 0
fi
if [[ "$mode" == migrate-schema ]]; then
  [[ "$schema_sha" != "$(< schema.sha256)" ]] || { echo 'Schema is unchanged; use ordinary prepare' >&2; exit 1; }
  maintenance_record=$(python3 "$script_dir/schema-maintenance.py" preflight "$root" "$image" "$source_sha" "$run_id" "$evidence_file")
  python3 "$script_dir/schema-maintenance.py" audit "$root" "$image"
else
  [[ "$schema_sha" == "$(< schema.sha256)" ]] || { echo 'Schema source changed; migration maintenance is required' >&2; exit 1; }
fi

# 兼容版本按服务生命周期切换，不要求消费者停写或业务队列为空。
# 这里只校验发布身份；旧 API 的正常退出在下方确认，不重置业务处理状态。
tunnel_ready || { echo 'Host Tunnel is not connected' >&2; exit 1; }
old_container=$("${compose[@]}" ps -q memoia)
[[ -n "$old_container" && -f deploy-state ]] || { echo 'No accepted running API to switch safely' >&2; exit 1; }
accepted_image=$(cut -d' ' -f3 deploy-state)
[[ "$accepted_image" =~ ^ghcr\.io/jianify/memoia@sha256:[0-9a-f]{64}$ && "$(docker inspect --format '{{.Config.Image}}' "$old_container")" == "$accepted_image" ]] || {
  echo 'Running API differs from the accepted deployment; review manual changes before switching' >&2; exit 1;
}
api_database_matches "$old_container" || { echo 'Running API database connection drifted' >&2; exit 1; }
redis_container=$("${compose[@]}" ps -q redis)
[[ -n "$redis_container" ]] || { echo 'Redis is not running' >&2; exit 1; }
expected_image=$(jq -r '.services.redis.image' <<< "$resolved")
[[ "$(docker inspect --format '{{.Config.Image}}' "$redis_container")" == "$expected_image" ]] || {
  echo 'Redis image differs from the recorded infrastructure' >&2
  exit 1
}
actual_mount=$(docker inspect "$redis_container" | jq -r '.[0].Mounts[] | select(.Destination == "/data") | .Source')
[[ "$actual_mount" == "$root/data/redis" ]] || {
  echo 'Redis data mount differs from the fixed absolute path' >&2
  exit 1
}
[[ "$(docker inspect --format '{{.State.Health.Status}}' "$redis_container")" == healthy ]] || {
  echo 'Redis is not healthy' >&2
  exit 1
}
printf 'redis %s\npostgres %s\n' "$redis_container" "$postgres_container" > pending-infra
systemctl show jianify-cloudflared.service -p MainPID -p ActiveEnterTimestamp > pending-tunnel
printf '%s %s %s %s\n' "$run_id" "$source_sha" "$image" "$config_sha" > pending-deploy
if [[ "$mode" == migrate-schema ]]; then
  install -d -m 700 "schema-archives/$run_id"
  cp deploy-state "schema-archives/$run_id/previous-deploy-state"
  cp schema.sha256 "schema-archives/$run_id/previous-schema.sha256"
  [[ ! -f previous-accepted ]] || cp previous-accepted "schema-archives/$run_id/previous-accepted"
  printf '%s\n' "$schema_sha" > pending-schema.sha256
  printf '%s\n' "$maintenance_record" > pending-maintenance
  cp "$evidence_file" "schema-archives/$run_id/preflight.json"
fi

"${compose[@]}" stop --timeout 90 memoia
[[ "$(docker inspect --format '{{.State.ExitCode}}' "$old_container")" == 0 ]] || {
  echo 'API did not exit gracefully; pending result preserved, candidate not started' >&2; exit 1;
}
if [[ "$mode" == migrate-schema ]]; then
  python3 "$script_dir/schema-maintenance.py" audit "$root" "$image"
  "${compose[@]}" run --rm --no-deps --entrypoint /app/.venv/bin/python memoia -m alembic upgrade head
  "${compose[@]}" run --rm --no-deps --entrypoint /app/.venv/bin/python memoia -c 'from memoia_server.schema import check_schema; check_schema()'
fi
MEMOIA_IMAGE="$image" "${compose[@]}" up -d --no-deps --no-build memoia
container=$("${compose[@]}" ps -q memoia)
for _attempt in $(seq 1 36); do
  status=$(docker inspect --format '{{.State.Health.Status}}' "$container")
  if [[ "$status" == healthy ]]; then
    [[ "$(docker inspect --format '{{.State.OOMKilled}} {{.RestartCount}}' "$container")" == 'false 0' ]] || {
      echo 'Candidate OOM or automatic restart; pending result preserved' >&2; exit 1;
    }
    exit 0
  fi
  [[ "$status" == unhealthy ]] && break
  sleep 5
done
echo 'Candidate API did not become healthy; pending result preserved' >&2
exit 1
