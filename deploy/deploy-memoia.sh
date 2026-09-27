#!/usr/bin/env bash
set -euo pipefail

# 日常发布配置只读；init-config 仅补缺失模板与权限，绝不覆盖已有值。
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
[[ "$EUID" == 0 ]] || { echo 'Run with sudo -n' >&2; exit 2; }
mode=${1:?init-config, init, prepare, finalize, restore-api, backup or restore-data}
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
  # 不递归 chown 数据目录；已有 PG/Redis 所有权由各自镜像管理。
  for directory in "$root/data" "$root/data/postgres" "$root/data/redis"; do
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
[[ "$mode" == init || "$mode" == prepare || "$mode" == finalize || "$mode" == restore-api ]] || exit 2
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
[[ "$(jq -r .name <<< "$resolved")" == memoia-test && "$(jq -r '.services.memoia.labels["io.jianify.environment"]' <<< "$resolved")" == test ]] || {
  echo 'Online deployment is disabled, and test identity must be explicit' >&2; exit 2;
}
for service in postgres redis; do
  [[ "$(jq -r --arg service "$service" '.services[$service].volumes[0].source' <<< "$resolved")" == "$root/data/$service" ]] || {
    echo 'Resolved data mount differs from the canonical absolute path' >&2; exit 1;
  }
done
python3 -c '
import json, sys
from urllib.parse import unquote, urlsplit
c = json.load(sys.stdin)["services"]
pg = urlsplit(c["memoia"]["environment"]["DATABASE_URL"])
redis = urlsplit(c["memoia"]["environment"]["REDIS_URL"])
p = c["postgres"]["environment"]
valid = (pg.hostname == "postgres" and (pg.port or 5432) == 5432
         and pg.path == "/" + p["POSTGRES_DB"]
         and unquote(pg.username or "") == p["POSTGRES_USER"]
         and unquote(pg.password or "") == p["POSTGRES_PASSWORD"]
         and redis.hostname == "redis" and (redis.port or 6379) == 6379
         and redis.path == "/0"
         and unquote(redis.password or "") == c["redis"]["environment"]["REDIS_PASSWORD"])
if not valid:
    sys.exit("API database/Redis connections do not match this isolated stack")
' <<< "$resolved"
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
[[ -f "$script_dir/infra-fingerprint.sh" && -f "$script_dir/schema-fingerprint.sh" ]] || exit 2
if [[ "$mode" != init ]]; then
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

if [[ "$mode" == finalize ]]; then
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
  for service in postgres redis; do
    [[ "$("${compose[@]}" ps -q "$service")" == "$(sed -n "/^$service /s/^$service //p" pending-infra)" ]] || {
      echo "Infrastructure service $service changed during API deployment" >&2
      exit 1
    }
  done
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
    if [[ "$(cut -d' ' -f3 deploy-state)" != "$image" ]]; then cp deploy-state previous-accepted; fi
  fi
  install -d -m 700 accepted
  printf '%s %s %s %s %s\n' "$run_id" "$source_sha" "$image" "$compose_sha" "$config_sha" > "$state_tmp"
  cp "$state_tmp" "accepted/$source_sha"
  printf '%s %s %s %s %s\n' "$high_water" "$source_sha" "$image" "$compose_sha" "$config_sha" > "$state_tmp"
  mv "$state_tmp" deploy-state
  rm pending-deploy pending-infra pending-tunnel
  exit 0
fi

[[ ! -e pending-deploy ]] || {
  echo 'Previous deployment has an unresolved result; operator review required' >&2
  exit 1
}
[[ ! -e pending-maintenance ]] || { echo 'Unresolved maintenance blocks deployment' >&2; exit 1; }
if [[ -f deploy-state && "$mode" != restore-api ]]; then
  previous_run=$(cut -d' ' -f1 deploy-state)
  (( run_id > previous_run )) || {
    echo 'Stale or repeated workflow run; use an explicit recovery procedure' >&2
    exit 1
  }
fi
if [[ "$mode" != restore-api ]]; then
head_sha=$(curl -fsSL --max-time 15 https://api.github.com/repos/jianify/memoia/git/ref/heads/test | jq -r .object.sha)
[[ "$head_sha" == "$source_sha" ]] || {
  echo 'A newer test branch head exists; refusing stale deployment' >&2
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
  for service in postgres redis memoia; do
    [[ -z "$("${compose[@]}" ps -aq "$service")" ]] || { echo 'Existing stack blocks initialization' >&2; exit 1; }
  done
  for directory in "$root/data/postgres" "$root/data/redis"; do
    [[ -d "$directory" && ! -L "$directory" && -z "$(find "$directory" -mindepth 1 -print -quit)" ]] || {
      echo 'First installation requires empty, fixed data directories' >&2; exit 1;
    }
  done
  tunnel_ready || { echo 'Host Tunnel is not connected' >&2; exit 1; }
  bash "$script_dir/infra-fingerprint.sh" "$root" > infra-config.sha256
  printf '%s\n' "$schema_sha" > schema.sha256
  printf '%s %s %s %s\n' "$run_id" "$source_sha" "$image" "$config_sha" > pending-deploy
  systemctl show jianify-cloudflared.service -p MainPID -p ActiveEnterTimestamp > pending-tunnel
  MEMOIA_IMAGE="$image" "${compose[@]}" up -d --no-build
  for service in postgres redis; do printf '%s %s\n' "$service" "$("${compose[@]}" ps -q "$service")"; done > pending-infra
  echo 'First stack started; business acceptance is required before finalize. Automatic updates remain disabled.'
  exit 0
fi
[[ "$schema_sha" == "$(< schema.sha256)" ]] || { echo 'Schema source changed; migration maintenance is required' >&2; exit 1; }

# 兼容版本按服务生命周期切换，不要求消费者停写或业务队列为空。
# 这里只校验发布身份；旧 API 的正常退出在下方确认，不重置业务处理状态。
tunnel_ready || { echo 'Host Tunnel is not connected' >&2; exit 1; }
old_container=$("${compose[@]}" ps -q memoia)
[[ -n "$old_container" && -f deploy-state ]] || { echo 'No accepted running API to switch safely' >&2; exit 1; }
accepted_image=$(cut -d' ' -f3 deploy-state)
[[ "$accepted_image" =~ ^ghcr\.io/jianify/memoia@sha256:[0-9a-f]{64}$ && "$(docker inspect --format '{{.Config.Image}}' "$old_container")" == "$accepted_image" ]] || {
  echo 'Running API differs from the accepted deployment; review manual changes before switching' >&2; exit 1;
}
for service in postgres redis; do
  container=$("${compose[@]}" ps -q "$service")
  [[ -n "$container" ]] || { echo "$service is not running" >&2; exit 1; }
  expected_image=$("${compose[@]}" config --format json | jq -r --arg service "$service" '.services[$service].image')
  [[ "$(docker inspect --format '{{.Config.Image}}' "$container")" == "$expected_image" ]] || {
    echo "$service image differs from the recorded infrastructure" >&2
    exit 1
  }
  expected_mount=$("${compose[@]}" config --format json | jq -r --arg service "$service" '.services[$service].volumes[0].source')
  actual_mount=$(docker inspect "$container" | jq -r --arg service "$service" '.[0].Mounts[] | select(.Destination == (if $service == "postgres" then "/var/lib/postgresql/data" else "/data" end)) | .Source')
  [[ "$expected_mount" == "$root/data/$service" && "$actual_mount" == "$expected_mount" ]] || {
    echo "$service data mount differs from the fixed absolute path" >&2
    exit 1
  }
  [[ "$(docker inspect --format '{{.State.Health.Status}}' "$container")" == healthy ]] || {
    echo "$service is not healthy" >&2
    exit 1
  }
  printf '%s %s\n' "$service" "$container"
done > pending-infra
systemctl show jianify-cloudflared.service -p MainPID -p ActiveEnterTimestamp > pending-tunnel
printf '%s %s %s %s\n' "$run_id" "$source_sha" "$image" "$config_sha" > pending-deploy

"${compose[@]}" stop --timeout 90 memoia
[[ "$(docker inspect --format '{{.State.ExitCode}}' "$old_container")" == 0 ]] || {
  echo 'API did not exit gracefully; pending result preserved, candidate not started' >&2; exit 1;
}
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
