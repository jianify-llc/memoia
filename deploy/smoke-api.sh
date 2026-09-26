#!/usr/bin/env bash
set -euo pipefail

origin=${1:?HTTPS origin}
token=${2:?test Bearer token}
[[ "$origin" =~ ^https://[a-z0-9.-]+$ ]] || exit 2

curl -fsS --max-time 20 "$origin/api/v1/healthcheck" | jq -e '.errno == 0' >/dev/null
code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 20 \
  -X POST -H 'Content-Type: application/json' -d '{}' "$origin/api/v1/users")
[[ "$code" == 401 ]] || { echo 'Missing Bearer token was not rejected' >&2; exit 1; }
code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 20 \
  -X POST -H 'Authorization: Bearer deliberately-invalid' -H 'Content-Type: application/json' \
  -d '{}' "$origin/api/v1/users")
[[ "$code" == 401 ]] || { echo 'Wrong Bearer token was not rejected' >&2; exit 1; }

created=$(curl -fsS --max-time 20 -X POST \
  -H "Authorization: Bearer $token" -H 'Content-Type: application/json' \
  -d '{"data":{"memoia_release_probe":true}}' "$origin/api/v1/users")
user_id=$(jq -er '.data.id' <<< "$created")
[[ "$user_id" =~ ^[0-9a-f-]{36}$ ]] || exit 1
trap 'echo "Probe user $user_id needs manual cleanup" >&2' EXIT
curl -fsS --max-time 20 -H "Authorization: Bearer $token" \
  "$origin/api/v1/users/$user_id" | jq -e '.errno == 0 and .data.data.memoia_release_probe == true' >/dev/null
curl -fsS --max-time 20 -X DELETE -H "Authorization: Bearer $token" \
  "$origin/api/v1/users/$user_id" | jq -e '.errno == 0' >/dev/null
trap - EXIT
