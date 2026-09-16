# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import os

from app.core.config import settings

_EXECUTOR_MANAGER_BASE = settings.EXECUTOR_MANAGER_URL.rstrip("/")

EXECUTOR_DELETE_BY_TASK_ID_URL = os.getenv(
    "EXECUTOR_DELETE_BY_TASK_ID_URL",
    f"{_EXECUTOR_MANAGER_BASE}/executor-manager/executor/delete-by-task-id",
)
EXECUTOR_DELETE_POD_BY_NAME_URL = os.getenv(
    "EXECUTOR_DELETE_POD_BY_NAME_URL",
    f"{_EXECUTOR_MANAGER_BASE}/executor-manager/executor/delete-pod-by-name",
)
EXECUTOR_OLD_TASK_IDS_URL = os.getenv(
    "EXECUTOR_OLD_TASK_IDS_URL",
    f"{_EXECUTOR_MANAGER_BASE}/executor-manager/executor/old-task-ids",
)
EXECUTOR_SANDBOX_CLEANUP_BY_TASK_URL = os.getenv(
    "EXECUTOR_SANDBOX_CLEANUP_BY_TASK_URL",
    f"{_EXECUTOR_MANAGER_BASE}/executor-manager/sandboxes/cleanup-by-task",
)
EXECUTOR_CLEANUP_STALE_WARMPOOLS_URL = os.getenv(
    "EXECUTOR_CLEANUP_STALE_WARMPOOLS_URL",
    f"{_EXECUTOR_MANAGER_BASE}/executor-manager/executor/cleanup-stale-warmpools",
)
ORPHAN_POD_CLEANUP_ENABLED = (
    os.getenv("ORPHAN_POD_CLEANUP_ENABLED", "true").lower() == "true"
)
ORPHAN_POD_CLEANUP_INTERVAL_SECONDS = int(
    os.getenv("ORPHAN_POD_CLEANUP_INTERVAL_SECONDS", "10800")
)
ORPHAN_POD_MIN_AGE_HOURS = int(os.getenv("ORPHAN_POD_MIN_AGE_HOURS", "48"))
ORPHAN_POD_CLEANUP_IDLE_HOURS = int(os.getenv("ORPHAN_POD_CLEANUP_IDLE_HOURS", "24"))
# Once a pod has been idle longer than this, force-delete it even when the normal
# archive-then-delete path failed, to prevent archive failures from leaking pods.
ORPHAN_POD_CLEANUP_MAX_IDLE_HOURS = int(
    os.getenv("ORPHAN_POD_CLEANUP_MAX_IDLE_HOURS", "168")  # 7 days
)
# Grace period before a SandboxWarmPool CR whose template no longer matches the
# current WARMPOOL_TEMPLATE_NAME may be deleted by orphan cleanup.
ORPHAN_WARMPOOL_CR_GRACE_PERIOD_DAYS = int(
    os.getenv("ORPHAN_WARMPOOL_CR_GRACE_PERIOD_DAYS", "7")
)
# Mirrors the awk '$1+0 > 1000' guard in delete_notfound_pods.sh: skip pods whose
# task_id label is missing or not a valid integer above this threshold.
ORPHAN_POD_MIN_TASK_ID = int(os.getenv("ORPHAN_POD_MIN_TASK_ID", "1000"))
