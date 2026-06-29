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
ORPHAN_POD_CLEANUP_INTERVAL_SECONDS = int(
    os.getenv("ORPHAN_POD_CLEANUP_INTERVAL_SECONDS", "10800")
)
ORPHAN_POD_MIN_AGE_HOURS = int(os.getenv("ORPHAN_POD_MIN_AGE_HOURS", "48"))
