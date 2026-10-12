# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Separate collaboration handoff identities from conversation identities."""

from app.models.loop_item_execution import LoopItemExecution


def execution_conversation_task_id(execution: LoopItemExecution) -> str:
    """Address the initial manager created by runtime.collaboration.dispatch."""
    if execution.executor_type == "collaboration_group_dispatch":
        return f"{execution.runtime_task_id}-manager-initial"
    return execution.runtime_task_id
