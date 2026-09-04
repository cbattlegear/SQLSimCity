#!/usr/bin/env bash
set -Eeuo pipefail

if [[ "$#" -ne 1 ]]; then
  echo "usage: $0 <exact-image-reference>" >&2
  exit 64
fi

for command in curl docker node; do
  if ! command -v "${command}" >/dev/null 2>&1; then
    echo "required command not found: ${command}" >&2
    exit 69
  fi
done

image="$1"
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
container_name="sqlsimcity-smoke-${RANDOM}-$$"
fail_name="${container_name}-fail-closed"
container_id=""
fail_id=""
work_dir="$(mktemp -d)"

cleanup() {
  if [[ -n "${container_id}" ]]; then
    docker rm --force "${container_id}" >/dev/null 2>&1 || true
  fi
  if [[ -n "${fail_id}" ]]; then
    docker rm --force "${fail_id}" >/dev/null 2>&1 || true
  fi
  rm -rf -- "${work_dir}"
}
trap cleanup EXIT

container_id="$(docker run --detach \
  --name "${container_name}" \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=64m \
  --tmpfs /data:rw,noexec,nosuid,size=64m \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --publish 127.0.0.1::8080 \
  "${image}")"

port=""
healthy=false
for ((attempt = 0; attempt < 60; attempt++)); do
  binding="$(docker port "${container_id}" 8080/tcp 2>/dev/null | head -n 1)"
  if [[ -n "${binding}" && "${binding}" != 127.0.0.1:* ]]; then
    echo "fixture container published a non-loopback port: ${binding}" >&2
    exit 1
  fi
  port="${binding##*:}"
  if [[ -n "${port}" ]] && curl --fail --silent --show-error \
    --connect-timeout 1 --max-time 2 \
    "http://127.0.0.1:${port}/healthz" \
    --output "${work_dir}/health.json"; then
    healthy=true
    break
  fi
  if [[ "$(docker inspect --format '{{.State.Running}}' "${container_id}")" != "true" ]]; then
    echo "fixture container exited before becoming healthy" >&2
    exit 1
  fi
  sleep 1
done

if [[ "${healthy}" != true ]]; then
  echo "fixture container did not become healthy on its loopback port" >&2
  exit 1
fi

check_endpoint() {
  local path="$1"
  local shape="$2"
  local expected_status="${3:-200}"
  local output="${work_dir}/${shape}.json"
  local status
  status="$(curl --silent --show-error \
    --connect-timeout 2 --max-time 5 \
    "http://127.0.0.1:${port}${path}" \
    --output "${output}" --write-out '%{http_code}')"
  if [[ "${status}" != "${expected_status}" ]]; then
    echo "${path}: expected HTTP ${expected_status}, received ${status}" >&2
    exit 1
  fi
  node "${script_dir}/validate-smoke-response.mjs" "${output}" "${shape}"
}

node "${script_dir}/validate-smoke-response.mjs" "${work_dir}/health.json" health
check_endpoint /readyz readiness
check_endpoint /api/v1/atlas atlas
check_endpoint /api/v1/live live
check_endpoint /api/v1/query-store/status query-store-status
check_endpoint "/api/v1/query-store/queries?pageSize=1" query-store-queries
check_endpoint /api/v1/capabilities capabilities
check_endpoint /api/v1/database-city database-city
check_endpoint /api/v1/findings/status findings-retired 410
check_endpoint /api/v1/findings/export findings-retired 410

docker stop --time 10 "${container_id}" >/dev/null
docker rm "${container_id}" >/dev/null
container_id=""

fail_id="$(docker run --detach \
  --name "${fail_name}" \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=64m \
  --tmpfs /data:rw,noexec,nosuid,size=64m \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --env Atlas__Mode=Connected \
  --env QueryStoreHistory__Mode=Connected \
  "${image}")"

fail_running=true
for ((attempt = 0; attempt < 30; attempt++)); do
  fail_running="$(docker inspect --format '{{.State.Running}}' "${fail_id}")"
  if [[ "${fail_running}" == "false" ]]; then
    break
  fi
  sleep 1
done
if [[ "${fail_running}" != "false" ]]; then
  echo "connected fail-closed container did not exit within 30 seconds" >&2
  exit 1
fi
docker logs "${fail_id}" >"${work_dir}/fail-closed.log" 2>&1
fail_status="$(docker inspect --format '{{.State.ExitCode}}' "${fail_id}")"

if [[ "${fail_status}" -eq 0 ]]; then
  echo "connected Query Store mode unexpectedly started without protected storage" >&2
  exit 1
fi
if ! grep --fixed-strings --quiet \
  "Connected Query Store history retains query text and plan XML, so it requires ProtectedStorage:Enabled=true." \
  "${work_dir}/fail-closed.log"; then
  echo "connected Query Store mode did not emit the curated protected-storage requirement" >&2
  exit 1
fi
if grep --extended-regexp --ignore-case --quiet \
  '(password|pwd|access.?token|client.?secret|connection.?string)[[:space:]]*[:=][[:space:]]*[^[:space:]]+' \
  "${work_dir}/fail-closed.log"; then
  echo "fail-closed output contained a possible secret value" >&2
  exit 1
fi

docker rm "${fail_id}" >/dev/null
fail_id=""

echo "container smoke checks passed"
