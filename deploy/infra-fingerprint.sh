#!/usr/bin/env bash
set -euo pipefail
root=${1:?deployment root}
config_sha=$(sha256sum "$root/api/config.yaml" | cut -d' ' -f1)
docker compose --env-file "$root/.env" -f "$root/docker-compose.yml" config --format json \
  | jq -Sc --arg config_sha "$config_sha" '{postgres:.services.postgres,redis:.services.redis,api_contract:{database_url:.services.memoia.environment.DATABASE_URL,redis_url:.services.memoia.environment.REDIS_URL,project_id:.services.memoia.environment.PROJECT_ID,config_sha:$config_sha}}' \
  | sha256sum | cut -d' ' -f1
