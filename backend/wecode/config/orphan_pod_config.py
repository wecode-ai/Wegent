# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import os

EXECUTOR_DELETE_BY_TASK_ID_URL = os.getenv(
    "EXECUTOR_DELETE_BY_TASK_ID_URL",
    "http://localhost:8001/executor-manager/executor/delete-by-task-id",
)
EXECUTOR_DELETE_POD_BY_NAME_URL = os.getenv(
    "EXECUTOR_DELETE_POD_BY_NAME_URL",
    "http://localhost:8001/executor-manager/executor/delete-pod-by-name",
)
EXECUTOR_OLD_TASK_IDS_URL = os.getenv(
    "EXECUTOR_OLD_TASK_IDS_URL",
    "http://localhost:8001/executor-manager/executor/old-task-ids",
)
ORPHAN_POD_CLEANUP_ENABLED = (
    os.getenv("ORPHAN_POD_CLEANUP_ENABLED", "true").lower() == "true"
)
ORPHAN_POD_CLEANUP_INTERVAL_SECONDS = int(
    os.getenv("ORPHAN_POD_CLEANUP_INTERVAL_SECONDS", "10800")
)
ORPHAN_POD_MIN_AGE_HOURS = int(os.getenv("ORPHAN_POD_MIN_AGE_HOURS", "48"))
ORPHAN_POD_CLEANUP_STALE_HOURS = int(os.getenv("ORPHAN_POD_CLEANUP_STALE_HOURS", "24"))
# Mirrors the awk '$1+0 > 1000' guard in delete_notfound_pods.sh: skip pods whose
# task_id label is missing or not a valid integer above this threshold.
ORPHAN_POD_MIN_TASK_ID = int(os.getenv("ORPHAN_POD_MIN_TASK_ID", "1000"))
