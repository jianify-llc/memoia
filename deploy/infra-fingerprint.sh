#!/usr/bin/env bash
set -euo pipefail
root=${1:?deployment root}
worker_contract=true
[[ "${2:-}" != legacy-api-only ]] || worker_contract=false
config_sha=$(sha256sum "$root/api/config.yaml" | cut -d' ' -f1)
postgres_sha=$(python3 /opt/postgres/postgresctl.py fingerprint)
docker compose --env-file "$root/.env" -f "$root/docker-compose.yml" config --format json \
  | jq -Sc --arg config_sha "$config_sha" --arg postgres_sha "$postgres_sha" --argjson worker "$worker_contract" '{postgres_fingerprint:$postgres_sha,redis:.services.redis,data_network:.networks.data,api_contract:{database_url:.services.memoia.environment.DATABASE_URL,redis_url:.services.memoia.environment.REDIS_URL,project_id:.services.memoia.environment.PROJECT_ID,config_sha:$config_sha}} + (if $worker then {worker_contract:(.services.maintenance | {command,healthcheck,networks,volumes,restart,stop_grace_period,concurrency:.environment.MAINTENANCE_CONCURRENCY,database_url:.environment.DATABASE_URL,redis_url:.environment.REDIS_URL,project_id:.environment.PROJECT_ID})} else {} end)' \
  | sha256sum | cut -d' ' -f1
