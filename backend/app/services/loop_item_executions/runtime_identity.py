# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Separate collaboration handoff identities from conversation identities."""

from app.models.loop_item_execution import LoopItemExecution
from app.schemas.runtime_work import RuntimeTaskCreateRequest

RUNTIME_TASK_ID_PREFIX = "codex-queue"


def bind_comment_user_identity(
    request: RuntimeTaskCreateRequest, execution: LoopItemExecution
) -> RuntimeTaskCreateRequest:
    """Bind either producer's request to its persisted source comment at dispatch."""
    message_id = execution.runtime_origin_context.get("comment_trigger_message_id")
    if not isinstance(message_id, str) or not message_id.strip():
        return request
    return request.model_copy(update={"client_user_message_id": message_id})


def execution_actor_options(execution: LoopItemExecution) -> dict[str, int]:
    """Keep the enabling member as actor, independently of device/definition ownership."""
    if (
        execution.uses_runner_routing
        or "project_coordination" in execution.runtime_origin_context
    ):
        return {"execution_user_id": execution.assigner_user_id}
    return {}


def runtime_task_id_for(execution_id: int) -> str:
    """Return the canonical runtime task id for one execution."""
    return f"{RUNTIME_TASK_ID_PREFIX}-{execution_id}"


def execution_runtime_task_id(execution: LoopItemExecution) -> str:
    """A queued reply resumes its thread; a root execution gets a new task."""
    return str(
        execution.runtime_origin_context.get("comment_continue_task_id")
        or runtime_task_id_for(execution.id)
    )


def execution_runtime_turn_id(execution: LoopItemExecution) -> str:
    """Return the deterministic turn id generated for an execution pull."""
    task_id = execution.runtime_task_id or execution_runtime_task_id(execution)
    return f"{task_id}-execution-{execution.id}"


def execution_conversation_task_id(execution: LoopItemExecution) -> str:
    """Address the initial manager created by runtime.collaboration.dispatch."""
    task_id = execution.runtime_task_id or execution_runtime_task_id(execution)
    if execution.executor_type == "collaboration_group_dispatch":
        return f"{task_id}-manager-initial"
    return task_id
