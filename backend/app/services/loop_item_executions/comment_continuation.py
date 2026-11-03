"""Prepare persisted comment continuations when consuming their queue entries."""

from typing import TYPE_CHECKING, Any

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models.delivery import LoopItem, ProjectChatAgent
from app.models.loop_item_execution import LoopItemExecution
from app.schemas.runtime_work import RuntimeTaskMaterializeRequest
from app.services.device.identity import resolve_owned_device_alias
from app.services.project_chat.service import bot_config
from app.services.runner_routing import active_device, issue_binding, routing_error

if TYPE_CHECKING:
    from app.services.loop_item_executions.service import LoopItemExecutionService


def prepare_continuation(
    db: Session, row: LoopItemExecution, source: dict[str, Any], context: dict[str, Any]
) -> dict[str, Any] | None:
    """Revalidate the original session; an unclaimed parent remains queued."""
    original = (
        db.get(LoopItemExecution, source["execution_id"])
        if source.get("execution_id")
        else None
    )
    if source.get("execution_id") and original is None:
        raise HTTPException(409, "The original execution is unavailable")
    if original is not None:
        if (
            original.cloud_project_id != row.cloud_project_id
            or original.loop_item_id != row.loop_item_id
        ):
            raise HTTPException(409, "The original session belongs to another Issue")
        if not original.runtime_device_id and original.status in {
            "queued",
            "pending_approval",
            "waiting_runtime",
        }:
            return None
        source = {
            **source,
            "owner_user_id": original.executor_owner_user_id,
            "runtime_device_id": original.runtime_device_id,
            "runtime_request": original.runtime_request,
            "runtime_selection": original.runtime_selection,
        }
    bound_id = issue_binding(db, row.loop_item_id)
    bound = active_device(db, bound_id) if bound_id else None
    if bound is None:
        raise routing_error(
            "ISSUE_RUNNER_CONFIGURATION_REQUIRED",
            "The original session's environment must be restored before replying",
        )
    device = resolve_owned_device_alias(
        db, user_id=source["owner_user_id"], device_id=source["runtime_device_id"]
    )
    if device is None or device.id != bound.id:
        raise routing_error(
            "ISSUE_RUNNER_CONFLICT",
            "The comment session belongs to a different environment than this Issue",
        )
    if not source["runtime_request"]:
        raise HTTPException(409, "The original execution configuration is unavailable")
    context["runtime_subject_user_id"] = bound.user_id
    config = bot_config(db.get(ProjectChatAgent, row.agent_id))
    selection = dict(context.get("runner_selection") or {})
    if (config.get("execution_policy") or {}).get("mode") == "user_select":
        selection.setdefault(
            "execution_policy", {"mode": "fixed", "environment_id": bound_id}
        )
    if (config.get("model_policy") or {}).get("mode") == "user_select":
        selection.setdefault(
            "model", source["runtime_selection"].get("runner_routing", {}).get("model")
        )
    context["runner_selection"] = selection
    if context.get("dispatch_kind") == "collaboration_group":
        _require_group_dispatch(db, row, context)
    return source


def _require_group_dispatch(db: Session, row: LoopItemExecution, context: dict) -> None:
    from app.services.collaboration_group_execution import (
        collaboration_group_snapshot_for_dispatch,
    )

    dispatch = db.get(
        LoopItemExecution, context.get("collaboration_dispatch_execution_id")
    )
    if (
        dispatch is None
        or dispatch.executor_type != "collaboration_group_dispatch"
        or dispatch.cloud_project_id != row.cloud_project_id
        or dispatch.loop_item_id != row.loop_item_id
        or dispatch.runtime_origin_context.get("dispatch_id")
        != context.get("dispatch_id")
    ):
        raise HTTPException(409, "The collaboration dispatch is unavailable")
    collaboration_group_snapshot_for_dispatch(
        item=db.get(LoopItem, row.loop_item_id), execution=dispatch
    )


def apply_continuation(
    service: "LoopItemExecutionService",
    db: Session,
    row: LoopItemExecution,
    source: dict[str, Any],
) -> None:
    context = row.runtime_origin_context
    selection = row.runtime_selection
    if context.get("dispatch_role") == "manager":
        from app.services.runner_routing import resolve_group_routing

        selection["group_runner_requirements"] = resolve_group_routing(
            db,
            group=context["collaboration_group"],
            project_id=row.cloud_project_id,
            issue_id=row.loop_item_id,
            user_id=row.assigner_user_id,
            selection=context.get("runner_selection"),
        )
    intent = RuntimeTaskMaterializeRequest.model_validate(
        source["runtime_request"]
    ).model_copy(
        update={
            "message": context["comment_prompt"],
            "new_session": False,
            "device_id": source["runtime_device_id"],
            "local_task_id": source["runtime_task_id"],
            "attachment_ids": [],
            "attachments": context["attachments"],
            "origin": {
                **(source["runtime_request"].get("origin") or {}),
                **context,
                "type": "board_comment",
                "executionId": row.id,
            },
        }
    )
    row.executor_owner_user_id = source["owner_user_id"]
    row.runtime_device_id = source["runtime_device_id"]
    row.execution_payload = service._serialize_execution_intent(
        runtime_selection=selection,
        origin_context=context,
        runtime_request=intent.model_dump(by_alias=True, exclude_none=True),
    )
