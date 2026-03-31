# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Compatibility wrapper for task-scoped skill identity helpers."""

from shared.models.execution import ExecutionRequest
from shared.utils.task_identity import (
    build_task_identity_context as _build_task_identity_context,
)


def build_task_identity_context(request: ExecutionRequest) -> dict[str, str]:
    """Build task identity env from an execution request."""
    return _build_task_identity_context(request)
