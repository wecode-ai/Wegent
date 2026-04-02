#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
BACKEND_DIR="${ROOT_DIR}/backend"
ENV_FILE="${ROOT_DIR}/.env"
BACKEND_LOG="${ROOT_DIR}/.pids/backend.log"
EXECUTOR_MANAGER_LOG="${ROOT_DIR}/.pids/executor_manager.log"

if [[ $# -lt 1 ]]; then
  cat <<'EOF'
Usage:
  scripts/smoke-test-workspace-recovery.sh <task_id> [sentinel_file] [sentinel_content]

Example:
  scripts/smoke-test-workspace-recovery.sh 1385 PROJECT_README.md restore-smoke-20260401
EOF
  exit 1
fi

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "Missing ${ENV_FILE}" >&2
  exit 1
fi

TASK_ID="$1"
SENTINEL_FILE="${2:-PROJECT_README.md}"
SENTINEL_CONTENT="${3:-restore-smoke-$(date +%Y%m%d-%H%M%S)}"

set -a
source "${ENV_FILE}"
set +a

run_backend_python() {
  (
    cd "${BACKEND_DIR}"
    uv run python -
  )
}

load_task_state() {
  eval "$(
    TASK_ID="${TASK_ID}" run_backend_python <<'PY'
import os
import shlex

from app.db.session import SessionLocal
from app.models.subtask import Subtask, SubtaskRole
from app.models.task import TaskResource

task_id = int(os.environ["TASK_ID"])
db = SessionLocal()
try:
    task = (
        db.query(TaskResource)
        .filter(TaskResource.id == task_id, TaskResource.kind == "Task")
        .first()
    )
    if not task:
        raise SystemExit(f"task {task_id} not found")

    task_status = (task.json or {}).get("status") or {}
    archive = task_status.get("archive") or {}

    workspace_name = ((task.json or {}).get("spec") or {}).get("workspaceRef", {}).get("name")
    workspace = None
    if workspace_name:
        workspace = (
            db.query(TaskResource)
            .filter(
                TaskResource.user_id == task.user_id,
                TaskResource.kind == "Workspace",
                TaskResource.name == workspace_name,
            )
            .first()
        )

    repo_name = ""
    if workspace:
        repo = ((workspace.json or {}).get("spec") or {}).get("repository") or {}
        git_repo = repo.get("gitRepo") or ""
        git_url = repo.get("gitUrl") or ""
        if git_repo:
            repo_name = git_repo.rstrip("/").split("/")[-1]
        elif git_url:
            repo_name = git_url.rstrip("/").rsplit("/", 1)[-1].removesuffix(".git")

    workspace_dir = f"/workspace/{task_id}"
    if repo_name:
        workspace_dir = f"{workspace_dir}/{repo_name}"

    subtask = (
        db.query(Subtask)
        .filter(
            Subtask.task_id == task_id,
            Subtask.role == SubtaskRole.ASSISTANT,
            Subtask.executor_name.isnot(None),
            Subtask.executor_name != "",
        )
        .order_by(Subtask.id.desc())
        .first()
    )
    if not subtask:
        raise SystemExit(f"task {task_id} has no assistant subtask with executor")

    print(f'export TASK_USER_ID={task.user_id}')
    print(f'export LAST_ASSISTANT_ID={subtask.id}')
    print(f'export EXECUTOR_NAME={shlex.quote(subtask.executor_name or "")}')
    print(f'export EXECUTOR_NAMESPACE={shlex.quote(subtask.executor_namespace or "")}')
    print(f'export WORKSPACE_DIR={shlex.quote(workspace_dir)}')
    print(f'export ARCHIVE_STORAGE_KEY={shlex.quote(archive.get("storageKey", ""))}')
finally:
    db.close()
PY
  )"
}

mark_latest_assistant_deleted() {
  TASK_ID="${TASK_ID}" run_backend_python <<'PY'
import os

from app.db.session import SessionLocal
from app.models.subtask import Subtask, SubtaskRole

task_id = int(os.environ["TASK_ID"])
db = SessionLocal()
try:
    subtask = (
        db.query(Subtask)
        .filter(
            Subtask.task_id == task_id,
            Subtask.role == SubtaskRole.ASSISTANT,
            Subtask.executor_name.isnot(None),
            Subtask.executor_name != "",
        )
        .order_by(Subtask.id.desc())
        .first()
    )
    if not subtask:
        raise SystemExit("no assistant subtask found to mark deleted")
    subtask.executor_deleted_at = True
    db.commit()
    print(
        f"Marked assistant subtask {subtask.id} executor_deleted_at=True "
        f"for executor {subtask.executor_name}"
    )
finally:
    db.close()
PY
}

wait_for_new_assistant() {
  TASK_ID="${TASK_ID}" LAST_ASSISTANT_ID="${LAST_ASSISTANT_ID}" run_backend_python <<'PY'
import os
import shlex
import time

from app.db.session import SessionLocal
from app.models.subtask import Subtask, SubtaskRole

task_id = int(os.environ["TASK_ID"])
previous_id = int(os.environ["LAST_ASSISTANT_ID"])
deadline = time.time() + 180
db = SessionLocal()
try:
    while time.time() < deadline:
        subtask = (
            db.query(Subtask)
            .filter(
                Subtask.task_id == task_id,
                Subtask.role == SubtaskRole.ASSISTANT,
                Subtask.id > previous_id,
            )
            .order_by(Subtask.id.desc())
            .first()
        )
        if subtask and subtask.executor_name:
            print(f'export NEW_ASSISTANT_ID={subtask.id}')
            print(f'export NEW_EXECUTOR_NAME={shlex.quote(subtask.executor_name or "")}')
            print(f'export NEW_EXECUTOR_NAMESPACE={shlex.quote(subtask.executor_namespace or "")}')
            print(f'export NEW_ASSISTANT_STATUS={shlex.quote(str(subtask.status))}')
            break
        db.expire_all()
        time.sleep(2)
    else:
        raise SystemExit("timed out waiting for a new assistant subtask")
finally:
    db.close()
PY
}

wait_for_file_in_container() {
  local container_name="$1"
  local file_path="$2"
  local deadline=$((SECONDS + 180))

  while (( SECONDS < deadline )); do
    if docker ps --format '{{.Names}}' | grep -Fxq "${container_name}"; then
      if docker exec "${container_name}" sh -lc "test -f '${file_path}'"; then
        return 0
      fi
    fi
    sleep 2
  done

  return 1
}

echo "==> Loading task state for task ${TASK_ID}"
load_task_state

echo "    executor_name=${EXECUTOR_NAME}"
echo "    workspace_dir=${WORKSPACE_DIR}"

if ! docker ps --format '{{.Names}}' | grep -Fxq "${EXECUTOR_NAME}"; then
  echo "Current executor container ${EXECUTOR_NAME} is not running" >&2
  exit 1
fi

echo "==> Writing sentinel file into current executor"
docker exec \
  -e WORKSPACE_DIR="${WORKSPACE_DIR}" \
  -e SENTINEL_FILE="${SENTINEL_FILE}" \
  -e SENTINEL_CONTENT="${SENTINEL_CONTENT}" \
  "${EXECUTOR_NAME}" \
  sh -lc 'printf "%s\n" "$SENTINEL_CONTENT" > "$WORKSPACE_DIR/$SENTINEL_FILE" && ls -l "$WORKSPACE_DIR/$SENTINEL_FILE" && cat "$WORKSPACE_DIR/$SENTINEL_FILE"'

echo "==> Triggering backend archive endpoint"
archive_response="$(curl -sS -X POST "http://localhost:8000/api/internal/workspace-archives/${TASK_ID}/archive")"
echo "${archive_response}"

echo "==> Reloading task state to capture archive metadata"
load_task_state
if [[ -z "${ARCHIVE_STORAGE_KEY}" ]]; then
  echo "Archive metadata is missing after archive call" >&2
  exit 1
fi
echo "    archive_storage_key=${ARCHIVE_STORAGE_KEY}"

echo "==> Marking latest assistant subtask executor_deleted_at=True"
mark_latest_assistant_deleted

echo "==> Deleting current executor container ${EXECUTOR_NAME}"
docker rm -f "${EXECUTOR_NAME}"

echo "==> Manual step required"
echo "Send a new chat message for task ${TASK_ID} in the UI, then press Enter to continue."
read -r

echo "==> Waiting for a new assistant subtask and recovered executor"
eval "$(
  wait_for_new_assistant
)"

echo "    new_assistant_id=${NEW_ASSISTANT_ID}"
echo "    new_executor_name=${NEW_EXECUTOR_NAME}"
echo "    new_assistant_status=${NEW_ASSISTANT_STATUS}"

TARGET_FILE="${WORKSPACE_DIR}/${SENTINEL_FILE}"

echo "==> Waiting for sentinel file to appear in recovered executor"
if ! wait_for_file_in_container "${NEW_EXECUTOR_NAME}" "${TARGET_FILE}"; then
  echo "Sentinel file did not appear in ${NEW_EXECUTOR_NAME}" >&2
  echo "--- backend log ---"
  tail -n 120 "${BACKEND_LOG}" | rg 'RecoveryService|restore|archive|sandbox|ExecutionDispatcher|'"${TASK_ID}"
  echo "--- executor-manager log ---"
  tail -n 120 "${EXECUTOR_MANAGER_LOG}" | rg 'restore|archive|sandbox|heartbeat|'"${TASK_ID}"
  exit 1
fi

echo "==> Verifying sentinel file contents"
docker exec "${NEW_EXECUTOR_NAME}" sh -lc "ls -l '${TARGET_FILE}' && cat '${TARGET_FILE}'"

echo "==> Recent backend recovery logs"
tail -n 120 "${BACKEND_LOG}" | rg 'RecoveryService|restore|archive|sandbox|ExecutionDispatcher|'"${TASK_ID}" || true

echo "==> Recent executor-manager recovery logs"
tail -n 120 "${EXECUTOR_MANAGER_LOG}" | rg 'restore|archive|sandbox|heartbeat|'"${TASK_ID}" || true

echo "Smoke test passed for task ${TASK_ID}"
