#!/usr/bin/env bash
set -euo pipefail

origin=${1:?HTTPS origin}
token=${2:?test Bearer token}
[[ "$origin" =~ ^https://[a-z0-9.-]+$ ]] || exit 2

curl -fsS --max-time 20 "$origin/api/healthcheck" | jq -e '.status == "ok"' >/dev/null
code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 20 \
  -X POST -H 'Content-Type: application/json' -d '{}' "$origin/api/users")
[[ "$code" == 401 ]] || { echo 'Missing Bearer token was not rejected' >&2; exit 1; }
code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 20 \
  -X POST -H 'Authorization: Bearer deliberately-invalid' -H 'Content-Type: application/json' \
  -d '{}' "$origin/api/users")
[[ "$code" == 401 ]] || { echo 'Wrong Bearer token was not rejected' >&2; exit 1; }

created=$(curl -fsS --max-time 20 -X POST \
  -H "Authorization: Bearer $token" -H 'Content-Type: application/json' \
  -d '{"data":{"memoia_release_probe":true}}' "$origin/api/users")
user_id=$(jq -er '.id' <<< "$created")
[[ "$user_id" =~ ^[0-9a-f-]{36}$ ]] || exit 1
trap 'echo "Probe user $user_id needs manual cleanup" >&2' EXIT
curl -fsS --max-time 20 -H "Authorization: Bearer $token" \
  "$origin/api/users/$user_id" | jq -e '.data.memoia_release_probe == true' >/dev/null
curl -fsS --max-time 20 -X DELETE -H "Authorization: Bearer $token" \
  "$origin/api/users/$user_id" | jq --arg uid "$user_id" -e '.forgotten == true and .user_id == $uid' >/dev/null
trap - EXIT
