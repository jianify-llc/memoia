#!/usr/bin/env bash
set -euo pipefail

# Run only after first installation, with external memory writers paused.
mode=${1:?prepare or finalize}
root=${2:?deployment root}
image=${3:?manifest-addressed image}
source_sha=${4:?source commit}
run_id=${5:?GitHub run ID}
compose_sha=${6:?compose SHA-256}

[[ "$root" == /opt/memoia/test ]] || {
  echo 'Online deployment is disabled' >&2
  exit 2
}
[[ "$image" =~ ^ghcr\.io/jianify/memoia@sha256:[0-9a-f]{64}$ ]] || exit 2
[[ "$source_sha" =~ ^[0-9a-f]{40}$ ]] || exit 2
[[ "$run_id" =~ ^[0-9]+$ ]] || exit 2
[[ "$compose_sha" =~ ^[0-9a-f]{64}$ ]] || exit 2
[[ "$mode" == prepare || "$mode" == finalize ]] || exit 2

cd "$root"
exec 9> .deploy.lock
flock -x 9
[[ -f .env && -f image.env && -f compose.yml ]] || {
  echo 'First installation is not complete' >&2
  exit 1
}
[[ "$(sha256sum compose.yml | cut -d' ' -f1)" == "$compose_sha" ]] || {
  echo 'Compose changed; use the separate infrastructure maintenance procedure' >&2
  exit 1
}
[[ "$(stat -c %a .env)" == 600 ]] || {
  echo '.env must have mode 0600' >&2
  exit 1
}
[[ -f infra-config.sha256 && -f infra-fingerprint.sh ]] || {
  echo 'Infrastructure baseline is missing' >&2
  exit 1
}
[[ "$(bash infra-fingerprint.sh "$root")" == "$(sed -n '1p' infra-config.sha256)" ]] || {
  echo 'Infrastructure configuration changed; use separate maintenance' >&2
  exit 1
}

compose=(docker compose --env-file "$root/.env" --env-file "$root/image.env" -f "$root/compose.yml")
"${compose[@]}" config --quiet

if [[ "$mode" == finalize ]]; then
  [[ -f pending-deploy ]] || { echo 'No pending deployment' >&2; exit 1; }
  [[ "$(sed -n '1p' pending-deploy)" == "$run_id $source_sha $image" ]] || {
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
  for service in postgres redis cloudflared; do
    [[ "$("${compose[@]}" ps -q "$service")" == "$(sed -n "/^$service /s/^$service //p" pending-infra)" ]] || {
      echo "Infrastructure service $service changed during API deployment" >&2
      exit 1
    }
  done
  state_tmp=$(mktemp "$root/.deploy-state.XXXXXX")
  env_sha=$(sha256sum .env | cut -d' ' -f1)
  printf '%s %s %s %s %s\n' "$run_id" "$source_sha" "$image" "$compose_sha" "$env_sha" > "$state_tmp"
  mv "$state_tmp" deploy-state
  printf 'MEMOIA_IMAGE=%s\n' "$image" > image.env.next
  mv image.env.next image.env
  rm pending-deploy pending-infra
  exit 0
fi

[[ ! -e pending-deploy ]] || {
  echo 'Previous deployment has an unresolved result; operator review required' >&2
  exit 1
}
if [[ -f deploy-state ]]; then
  previous_run=$(cut -d' ' -f1 deploy-state)
  (( run_id > previous_run )) || {
    echo 'Stale or repeated workflow run; use an explicit recovery procedure' >&2
    exit 1
  }
fi
head_sha=$(curl -fsSL --max-time 15 https://api.github.com/repos/jianify/memoia/git/ref/heads/test | jq -r .object.sha)
[[ "$head_sha" == "$source_sha" ]] || {
  echo 'A newer test branch head exists; refusing stale deployment' >&2
  exit 1
}

# The test stack must be isolated from external producers for this automatic path.
[[ -f standalone-mode ]] || {
  echo 'External writers may be active; automatic deployment is disabled' >&2
  exit 1
}

active=$("${compose[@]}" exec -T postgres sh -c \
  "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -Atc \"SELECT count(*) FROM buffer_zones WHERE status IN ('processing', 'failed')\"" \
  | tr -d '[:space:]')
[[ "$active" == 0 ]] || { echo 'Processing or failed buffers block deployment' >&2; exit 1; }
project_id=$("${compose[@]}" config --format json | jq -r '.services.memoia.environment.PROJECT_ID')
for prefix in memobase:user_lock memobase:user_buffer_queue; do
  # shellcheck disable=SC2016 # Redis 环境变量须由容器内的 sh 展开，主机只注入 prefix。
  count=$("${compose[@]}" exec -T -e PROJECT_ID="$project_id" redis sh -c \
    'REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli --scan --pattern "'$prefix':${PROJECT_ID}:*" | wc -l' \
    | tr -d '[:space:]')
  [[ "$count" == 0 ]] || { echo "Pending $prefix keys block deployment" >&2; exit 1; }
done

for service in postgres redis cloudflared; do
  container=$("${compose[@]}" ps -q "$service")
  [[ -n "$container" ]] || { echo "$service is not running" >&2; exit 1; }
  expected_image=$("${compose[@]}" config --format json | jq -r --arg service "$service" '.services[$service].image')
  [[ "$(docker inspect --format '{{.Config.Image}}' "$container")" == "$expected_image" ]] || {
    echo "$service image differs from the recorded infrastructure" >&2
    exit 1
  }
  if [[ "$service" != cloudflared ]]; then
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
  fi
  printf '%s %s\n' "$service" "$container"
done > pending-infra
printf '%s %s %s\n' "$run_id" "$source_sha" "$image" > pending-deploy

MEMOIA_IMAGE="$image" "${compose[@]}" pull memoia
"${compose[@]}" stop --timeout 90 memoia
MEMOIA_IMAGE="$image" "${compose[@]}" up -d --no-deps --no-build memoia
container=$("${compose[@]}" ps -q memoia)
for _attempt in $(seq 1 36); do
  status=$(docker inspect --format '{{.State.Health.Status}}' "$container")
  [[ "$status" == healthy ]] && exit 0
  [[ "$status" == unhealthy ]] && break
  sleep 5
done
echo 'Candidate API did not become healthy; pending result preserved' >&2
exit 1
