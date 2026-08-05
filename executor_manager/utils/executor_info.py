# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Helpers for attaching resolved executor identity to task payloads."""

from typing import Any, Dict, Optional


def attach_executor_info(
    task: Dict[str, Any],
    executor_name: str,
    executor_namespace: Optional[str] = None,
) -> None:
    """Attach executor identity in both OpenAI and legacy payload formats."""
    if not executor_name:
        return

    namespace = executor_namespace or ""
    metadata = task.get("metadata")
    if isinstance(metadata, dict):
        metadata["executor_name"] = executor_name
        metadata["executor_namespace"] = namespace
        return

    task["executor_name"] = executor_name
    task["executor_namespace"] = namespace
