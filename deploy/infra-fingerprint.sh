#!/usr/bin/env bash
set -euo pipefail
root=${1:?deployment root}
docker compose --env-file "$root/.env" --env-file "$root/image.env" \
  -f "$root/compose.yml" config --format json \
  | jq -Sc '{postgres:.services.postgres,redis:.services.redis,cloudflared:.services.cloudflared,api_contract:{database_url:.services.memoia.environment.DATABASE_URL,redis_url:.services.memoia.environment.REDIS_URL,project_id:.services.memoia.environment.PROJECT_ID,embedding_dim:.services.memoia.environment.MEMOBASE_EMBEDDING_DIM}}' \
  | sha256sum | cut -d' ' -f1
