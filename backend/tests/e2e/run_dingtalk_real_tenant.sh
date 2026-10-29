#!/usr/bin/env bash
# Run only from a protected CI environment with isolated real services.
set -euo pipefail

: "${E2E_DINGTALK_REAL_TENANT:?set to 1 in the protected environment}"
: "${E2E_DINGTALK_CLIENT_ID:?protected setting required}"
: "${E2E_DINGTALK_CLIENT_secret:?protected setting required}"
: "${E2E_DINGTALK_CARD_TEMPLATE_ID:?protected setting required}"
: "${E2E_DINGTALK_GROUP_ID:?protected setting required}"
: "${E2E_DINGTALK_STAFF_ID:?protected setting required}"
: "${DWS_BINARY_PATH:?protected DWS executable required}"
: "${E2E_DINGTALK_JOB_IMAGE:?protected Backend image required}"
: "${E2E_DINGTALK_MODEL_IMAGE:?protected model harness image required}"
: "${E2E_DINGTALK_BOOTSTRAP_ADMIN_PASSWORD:?isolated test password required}"

test "${E2E_DINGTALK_REAL_TENANT}" = "1"
test -x "${DWS_BINARY_PATH}"

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
export E2E_REPORT_DIR="${E2E_REPORT_DIR:-$ROOT/.ci-artifacts/dingtalk-real-tenant}"
export E2E_API_URL="${E2E_API_URL:-http://localhost:8000}"
export E2E_MODEL_URL="${E2E_MODEL_URL:-http://localhost:9999/v1}"
export E2E_BOOTSTRAP_ADMIN_PASSWORD="${E2E_DINGTALK_BOOTSTRAP_ADMIN_PASSWORD}"
export WEGENT_HYBRID_STATE_FILE="${WEGENT_HYBRID_STATE_FILE:-$ROOT/backend/backend-hybrid.state}"
export DATABASE_URL="${DATABASE_URL:-mysql+pymysql://root:test123@mysql:3306/wegent_test}"
export REDIS_URL="${REDIS_URL:-redis://redis:6379/0}"
export ENVIRONMENT="${ENVIRONMENT:-development}"
export DB_AUTO_MIGRATE="${DB_AUTO_MIGRATE:-false}"
export INIT_DATA_ENABLED="${INIT_DATA_ENABLED:-true}"
export EMBEDDED_CELERY_ENABLED="${EMBEDDED_CELERY_ENABLED:-false}"
export SECRET_KEY="${SECRET_KEY:-test-secret-key-for-ci-testing}"
export ALGORITHM="${ALGORITHM:-HS256}"
export PYTHONPATH="$ROOT:$ROOT/backend"

command -v docker >/dev/null
command -v uv >/dev/null
mkdir -p "$E2E_REPORT_DIR"
network="dingtalk-real-e2e-${CI_JOB_ID:-local}"
backend="dingtalk-real-backend-${CI_JOB_ID:-local}"
model="dingtalk-real-model-${CI_JOB_ID:-local}"
mysql="dingtalk-real-mysql-${CI_JOB_ID:-local}"
redis="dingtalk-real-redis-${CI_JOB_ID:-local}"

cleanup() {
  docker rm -f "$backend" "$model" "$mysql" "$redis" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
}
trap cleanup EXIT
cleanup

docker network create "$network" >/dev/null
docker run -d --name "$mysql" --network "$network" --network-alias mysql \
  -e MYSQL_ROOT_PASSWORD=test123 -e MYSQL_DATABASE=wegent_test \
  mysql:8.0 >/dev/null
docker run -d --name "$redis" --network "$network" --network-alias redis \
  redis:7-alpine >/dev/null
docker run -d --name "$model" --network "$network" --network-alias localhost \
  --network-alias host.docker.internal --network-alias model \
  -e MOCK_MODEL_PORT=9999 \
  --entrypoint pnpm "$E2E_DINGTALK_MODEL_IMAGE" \
  exec tsx e2e/utils/mock-model-server.ts >/dev/null

for attempt in $(seq 1 60); do
  if docker exec "$mysql" mysqladmin ping -h localhost --silent; then
    break
  fi
  test "$attempt" -lt 60 || { echo "MySQL did not become ready"; exit 1; }
  sleep 1
done

docker run -d --name "$backend" --network "$network" --network-alias backend \
  --network-alias localhost --network-alias host.docker.internal \
  -p 8000:8000 \
  -e PORT=8000 \
  -e DATABASE_URL="$DATABASE_URL" \
  -e REDIS_URL="$REDIS_URL" \
  -e ENVIRONMENT="$ENVIRONMENT" \
  -e DB_AUTO_MIGRATE="$DB_AUTO_MIGRATE" \
  -e INIT_DATA_ENABLED="$INIT_DATA_ENABLED" \
  -e EMBEDDED_CELERY_ENABLED="$EMBEDDED_CELERY_ENABLED" \
  -e SECRET_KEY="$SECRET_KEY" \
  -e ALGORITHM="$ALGORITHM" \
  -e GIT_TOKEN_AES_KEY="${GIT_TOKEN_AES_KEY:?test crypto key required}" \
  -e GIT_TOKEN_AES_IV="${GIT_TOKEN_AES_IV:?test crypto IV required}" \
  -e WEGENT_HYBRID_STATE_FILE=/app/backend-hybrid.state \
  "$E2E_DINGTALK_JOB_IMAGE" >/dev/null

for attempt in $(seq 1 120); do
  if curl -fsS "$E2E_API_URL/api/docs" >/dev/null 2>&1; then
    break
  fi
  docker ps -q --filter "name=$backend" | grep -q . || {
    docker logs "$backend" --tail 100
    exit 1
  }
  test "$attempt" -lt 120 || { docker logs "$backend" --tail 100; exit 1; }
  sleep 1
done

docker cp "$backend":/app/backend-hybrid.state "$WEGENT_HYBRID_STATE_FILE"
cd "$ROOT/backend"
export E2E_TEST_SHA="${CI_COMMIT_SHA:-$(git -C "$ROOT" rev-parse HEAD)}"
uv run --no-sync python tests/e2e/dingtalk_subscription_real_tenant.py
