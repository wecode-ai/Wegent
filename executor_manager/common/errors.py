# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Stable error codes for executor submission failures.

Human-readable error messages can change freely (wording, punctuation, i18n).
Retry policy must depend only on these codes.
"""


class ExecutorErrorCode:
    """Stable identifiers propagated through executor submission results."""

    # The user has no remaining executor quota; retrying the same payload cannot
    # allocate a new runtime.
    USER_TASK_LIMIT = "user_task_limit"

    # The referenced executor no longer exists; the payload itself is stale.
    EXECUTOR_DELETED = "executor_deleted"

    # Executor configuration is invalid and must be fixed by an operator.
    EXECUTOR_CONFIG = "executor_config"


class ExecutorConfigError(RuntimeError):
    """Raised when executor configuration prevents dispatch."""

    error_code = ExecutorErrorCode.EXECUTOR_CONFIG
