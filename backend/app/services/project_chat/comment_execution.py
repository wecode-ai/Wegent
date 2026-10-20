# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Project-authorized comment execution, independent of the agent picker."""

import uuid
from typing import Any

from fastapi import HTTPException
from sqlalchemy import or_
from sqlalchemy.orm import Query, Session

from app.models.delivery import LoopItem, ProjectChatAgent, loop_datetime_is_unset
from app.models.loop_item_execution import LoopItemExecution
from app.models.project_chat_message import ProjectChatMessage
from app.schemas.base_role import BaseRole
from app.schemas.project_chat import (
    ProjectChatAgentFailure,
    ProjectChatCommentExecution,
    ProjectChatMessageView,
)
from app.services.cloud_projects.access import require_cloud_project_role
from app.services.device.identity import owned_device_aliases, same_owned_device
from app.services.loop_item_executions.service import loop_item_execution_service
from app.services.project_chat.push import push_project_chat_message
from app.services.project_chat.runtime_binding import (
    BoundCommentSession,
    resolve_bound_comment_session,
    resolve_collaboration_manager_session,
    resolve_collaboration_member_session,
)
from app.services.project_chat.service import bot_config, project_chat_service
from shared.telemetry.decorators import trace_async


def _messages(
    db: Session, request: ProjectChatCommentExecution
) -> Query[ProjectChatMessage]:
    return db.query(ProjectChatMessage).filter(
        ProjectChatMessage.project_id == request.project_id,
        ProjectChatMessage.task_id == request.task_id,
        loop_datetime_is_unset(ProjectChatMessage.deleted_at),
    )


def _thread_agent(
    db: Session, request: ProjectChatCommentExecution, trigger: ProjectChatMessage
) -> ProjectChatMessage | None:
    if not trigger.reply_to_message_id:
        return None
    root_id = trigger.thread_root_message_id or trigger.reply_to_message_id
    # Serialize turns of one thread before checking for an existing response.
    root = (
        _messages(db, request)
        .filter(ProjectChatMessage.message_id == root_id)
        .with_for_update()
        .one_or_none()
    )
    if root is None:
        raise HTTPException(409, "The comment thread is unavailable")
    return (
        _messages(db, request)
        .filter(
            ProjectChatMessage.sender_type == "agent",
            or_(
                ProjectChatMessage.message_id == root_id,
                ProjectChatMessage.thread_root_message_id == root_id,
            ),
        )
        .order_by(ProjectChatMessage.id.desc())
        .with_for_update()
        .first()
    )


def _session_execution(
    db: Session, request: ProjectChatCommentExecution, target: ProjectChatMessage
) -> LoopItemExecution | None:
    candidates = (
        db.query(LoopItemExecution)
        .filter(
            LoopItemExecution.cloud_project_id == request.project_id,
            LoopItemExecution.loop_item_id == request.task_id,
            LoopItemExecution.runtime_task_id == target.runtime_task_id,
        )
        .order_by(LoopItemExecution.id.desc())
        .all()
    )
    aliases = {
        owner: owned_device_aliases(
            db, user_id=owner, device_id=target.runtime_device_id
        )
        for owner in {row.executor_owner_user_id for row in candidates}
    }
    matches = [
        row
        for row in candidates
        if row.runtime_device_id in aliases[row.executor_owner_user_id]
    ]
    if len({row.executor_owner_user_id for row in matches}) > 1:
        raise HTTPException(409, "Project session has conflicting execution owners")
    return matches[0] if matches else None


def _execution(
    db: Session, request: ProjectChatCommentExecution, target: ProjectChatMessage
) -> LoopItemExecution | BoundCommentSession:
    if (target.metadata_json or {}).get("dispatch_role") == "manager" and (
        (target.metadata_json or {}).get("dispatch_id") or not target.agent_id
    ):
        return resolve_collaboration_manager_session(db, request, target)
    execution_id = (target.metadata_json or {}).get("execution_id")
    if (target.metadata_json or {}).get(
        "dispatch_role"
    ) == "member" and not execution_id:
        return resolve_collaboration_member_session(db, request, target)
    execution = db.get(LoopItemExecution, execution_id) if execution_id else None
    if execution is None and not execution_id:
        execution = _session_execution(db, request, target)
        if execution is None:
            return resolve_bound_comment_session(db, request, target)
    if (
        execution is None
        or execution.cloud_project_id != request.project_id
        or execution.loop_item_id != request.task_id
        or (target.agent_id and execution.agent_id != target.agent_id)
    ):
        raise HTTPException(409, "The comment has no valid execution binding")
    if not execution.team_id and (
        not target.runtime_task_id
        or not target.runtime_device_id
        or target.runtime_task_id != execution.runtime_task_id
        or not same_owned_device(
            db,
            user_id=execution.executor_owner_user_id,
            left_device_id=execution.runtime_device_id,
            right_device_id=target.runtime_device_id,
        )
    ):
        raise HTTPException(409, "The comment session no longer matches its execution")
    return execution


def _response(
    db: Session,
    request: ProjectChatCommentExecution,
    trigger: ProjectChatMessage,
    agent_id: str,
    name: str,
    execution: LoopItemExecution | BoundCommentSession,
) -> ProjectChatMessage:
    message_id = str(uuid.uuid4())
    row = ProjectChatMessage(
        message_id=message_id,
        client_message_id=message_id,
        project_id=request.project_id,
        task_id=request.task_id,
        sender_type="agent",
        sender_id=agent_id or f"execution:{execution.id}",
        sender_name=name,
        agent_id=agent_id or "",
        content="",
        message_type="agent_status",
        trigger_message_id=trigger.message_id,
        reply_to_message_id=trigger.message_id,
        thread_root_message_id=trigger.thread_root_message_id or trigger.message_id,
        runtime_device_id=execution.runtime_device_id or "",
        runtime_task_id=execution.runtime_task_id or "",
        metadata_json={
            "execution_id": execution.id,
            "executor_type": execution.executor_type,
            "run_status": "queued",
            **(
                {
                    "dispatch_role": execution.runtime_origin_context["dispatch_role"],
                    "dispatch_id": execution.runtime_origin_context.get("dispatch_id"),
                }
                if execution.runtime_origin_context.get("dispatch_role")
                else {}
            ),
        },
        status="pending",
    )
    db.add(row)
    db.flush()
    return row


def _attachments(
    db: Session, user_id: int, attachment_ids: list[int]
) -> list[dict[str, Any]]:
    from app.services.runtime_work_service import _runtime_attachment_payloads

    attachments = _runtime_attachment_payloads(db, user_id, attachment_ids)
    if len(attachments) != len(set(attachment_ids)):
        raise HTTPException(
            422, "An attachment is unavailable or belongs to another user"
        )
    return attachments


def _new_execution(
    db: Session,
    user_id: int,
    request: ProjectChatCommentExecution,
    trigger: ProjectChatMessage,
    attachments: list[dict[str, Any]],
) -> ProjectChatMessage | None:
    item = db.get(LoopItem, request.task_id)
    if item is None or item.cloud_project_id != request.project_id:
        raise HTTPException(409, "The project issue is unavailable")
    mentioned = {
        mention["id"]
        for mention in (trigger.metadata_json or {}).get("mentions", [])
        if mention.get("type") == "agent"
    }
    if len(mentioned) > 1:
        raise HTTPException(422, "A comment can start one agent session")
    agent_id = next(iter(mentioned), None) or item.assignee_agent_id
    if not agent_id:
        trigger.metadata_json = {
            **(trigger.metadata_json or {}),
            "execution_dispatch": "comment_only",
        }
        db.commit()
        return None
    agent = project_chat_service._agent_row(
        db, project_id=request.project_id, agent_id=agent_id, active_only=True
    )
    # An assigned agent has already been authorized for this issue. Selecting
    # a different agent still requires visibility in the project agent picker.
    if agent_id != item.assignee_agent_id:
        access = require_cloud_project_role(
            db, request.project_id, user_id, BaseRole.Developer
        )
    config = bot_config(agent)
    execution = loop_item_execution_service.create_for_assignment(
        db,
        loop_item_id=request.task_id,
        cloud_project_id=request.project_id,
        agent=agent,
        assigner_user_id=user_id,
        environment=config.get("execution_environment") or "local",
        execution_device_id=agent.device_id or None,
        priority=item.priority,
        automation_context={
            "runtime_subject_user_id": agent.created_by_user_id,
            "runner_selection": (
                request.runner_selection.model_dump()
                if request.runner_selection
                else None
            ),
            "comment_trigger_message_id": trigger.message_id,
            "comment_prompt": trigger.content,
            "rootCommentId": trigger.thread_root_message_id or trigger.message_id,
            "attachments": attachments,
            "comment_attachment_ids": request.attachment_ids,
            "comment_user_id": user_id,
        },
    )
    response = _response(
        db, request, trigger, agent.id, agent.title or agent.name or "AI", execution
    )
    response.metadata_json = {
        **response.metadata_json,
        "run_status": execution.status,
    }
    db.commit()
    return response


async def _continue_runtime(
    db: Session,
    request: ProjectChatCommentExecution,
    trigger: ProjectChatMessage,
    target: ProjectChatMessage,
    execution: LoopItemExecution | BoundCommentSession,
    attachments: list[dict[str, Any]],
) -> ProjectChatMessage:
    from app.schemas.runtime_work import RuntimeTaskCreateRequest
    from app.services.device.runtime_rpc_service import runtime_rpc_service
    from app.services.runtime_work_service import compile_runtime_task_create

    if not execution.runtime_request:
        raise HTTPException(409, "The original execution configuration is unavailable")
    # Recompile the persisted non-secret intent as its original owner. Never
    # accept an owner, device, model, workspace, or credential from the caller.
    intent = RuntimeTaskCreateRequest.model_validate(
        {**execution.runtime_request, "message": trigger.content}
    )
    intent = intent.model_copy(
        update={
            "message": trigger.content,
            "new_session": False,
            "device_id": execution.runtime_device_id,
            "attachment_ids": [],
            "attachments": attachments,
        }
    )
    compiled = compile_runtime_task_create(
        db=db, user_id=execution.executor_owner_user_id, request=intent
    )
    response = _response(
        db, request, trigger, execution.agent_id, target.sender_name, execution
    )
    project_chat_service._set_task_ai_state(
        db,
        row=response,
        trigger=trigger,
        agent=None,
        status_value="running",
        prompt=trigger.content,
        user_id=int(trigger.sender_id),
    )
    response.metadata_json = {**response.metadata_json, "run_status": "queued"}
    response.runtime_activity_key = project_chat_service._runtime_activity_key(
        execution.runtime_device_id, execution.runtime_task_id, trigger.message_id
    )
    db.commit()
    push_project_chat_message(
        project_chat_service.to_view(response, db=db).model_dump(by_alias=True)
    )
    try:
        payload = {
            "taskId": execution.runtime_task_id,
            "message": trigger.content,
            "clientUserMessageId": trigger.message_id,
            "queueIfBusy": True,
            "executionRequest": compiled.payload["executionRequest"],
            "attachments": attachments,
        }
        if compiled.payload.get("modelSelection"):
            payload["modelSelection"] = compiled.payload["modelSelection"]
        result = await runtime_rpc_service.call(
            user_id=execution.executor_owner_user_id,
            device_id=execution.runtime_device_id,
            method="runtime.tasks.send",
            payload=payload,
            timeout_seconds=75,
            allow_app_device_task_messaging=True,
        )
        if (
            result.get("success") is False
            or result.get("accepted") is False
            or result.get("error")
        ):
            raise HTTPException(
                502, str(result.get("error") or "Runtime rejected the reply")
            )
        queued = result.get("status") == "queued"
        response.status = "pending" if queued else "streaming"
        response.metadata_json = {
            **response.metadata_json,
            "run_status": "queued" if queued else "running",
            **(
                {"queue_position": result.get("queuePosition")}
                if result.get("queuePosition") is not None
                else {}
            ),
        }
        db.commit()
        push_project_chat_message(
            project_chat_service.to_view(response, db=db).model_dump(by_alias=True)
        )
    except Exception as exc:
        error = str(exc.detail) if isinstance(exc, HTTPException) else str(exc)
        failed = project_chat_service.fail_agent_response(
            db,
            user_id=int(trigger.sender_id),
            request=ProjectChatAgentFailure(
                project_id=request.project_id,
                task_id=request.task_id,
                message_id=response.message_id,
                error=error,
            ),
        )
        push_project_chat_message(failed.model_dump(by_alias=True))
        raise HTTPException(502, error) from exc
    db.refresh(response)
    return response


def _queue_reply(
    db: Session,
    user_id: int,
    request: ProjectChatCommentExecution,
    trigger: ProjectChatMessage,
    target: ProjectChatMessage,
    original: LoopItemExecution | BoundCommentSession,
    attachments: list[dict[str, Any]],
) -> ProjectChatMessage:
    """Keep offline replies in the same durable queue as first executions."""
    from app.schemas.runtime_work import RuntimeTaskMaterializeRequest
    from app.services.device.identity import resolve_owned_device_alias
    from app.services.project_chat.service import compiled_bot_config
    from app.services.runner_routing import active_device, issue_binding, routing_error

    bound_id = issue_binding(db, request.task_id)
    bound = active_device(db, bound_id) if bound_id else None
    if bound is None:
        raise routing_error(
            "ISSUE_RUNNER_CONFIGURATION_REQUIRED",
            "The original session's environment must be restored before replying",
        )
    original_device = resolve_owned_device_alias(
        db, user_id=bound.user_id, device_id=original.runtime_device_id
    )
    if original_device is None or original_device.id != bound.id:
        raise routing_error(
            "ISSUE_RUNNER_CONFLICT",
            "The comment session belongs to a different environment than this Issue",
        )

    agent = project_chat_service._agent_row(
        db, project_id=request.project_id, agent_id=original.agent_id, active_only=True
    )
    config = compiled_bot_config(db, agent, execution_user_id=user_id)
    selection = (
        request.runner_selection.model_dump(exclude_none=True)
        if request.runner_selection
        else {}
    )
    if (config.get("execution_policy") or {}).get(
        "mode"
    ) == "user_select" and "execution_policy" not in selection:
        selection["execution_policy"] = {
            "mode": "fixed",
            "environment_id": bound_id,
        }
    if (config.get("model_policy") or {}).get(
        "mode"
    ) == "user_select" and "model" not in selection:
        selection["model"] = (
            getattr(original, "runtime_selection", {})
            .get("runner_routing", {})
            .get("model")
        )
    if not original.runtime_request:
        raise HTTPException(409, "The original execution configuration is unavailable")
    group_reply = (
        original.runtime_origin_context.get("dispatch_kind") == "collaboration_group"
    )
    if group_reply:
        from app.services.collaboration_group_execution import (
            collaboration_group_snapshot_for_dispatch,
        )

        dispatch = db.get(
            LoopItemExecution,
            original.runtime_origin_context.get("collaboration_dispatch_execution_id"),
        )
        if (
            dispatch is None
            or dispatch.executor_type != "collaboration_group_dispatch"
            or dispatch.cloud_project_id != request.project_id
            or dispatch.loop_item_id != request.task_id
            or dispatch.runtime_origin_context.get("dispatch_id")
            != original.runtime_origin_context.get("dispatch_id")
        ):
            raise HTTPException(409, "The collaboration dispatch is unavailable")
        collaboration_group_snapshot_for_dispatch(
            item=db.get(LoopItem, request.task_id), execution=dispatch
        )
    context = {
        **(
            {
                **original.runtime_origin_context,
                "runtime_subject_user_id": original.executor_owner_user_id,
            }
            if group_reply
            else {}
        ),
        "runner_selection": selection,
        "runtime_subject_user_id": bound.user_id,
        "comment_continue_task_id": original.runtime_task_id,
        "comment_trigger_message_id": trigger.message_id,
        "comment_prompt": trigger.content,
        "rootCommentId": trigger.thread_root_message_id or trigger.message_id,
        "attachments": attachments,
        "comment_attachment_ids": request.attachment_ids,
        "comment_user_id": user_id,
    }
    from app.services.loop_item_executions.profile import wework_execution_environment

    environment = getattr(
        original, "execution_environment", None
    ) or wework_execution_environment(
        db,
        user_id=original.executor_owner_user_id,
        execution_device_id=original.runtime_device_id,
    )
    execution = loop_item_execution_service.create_for_assignment(
        db,
        loop_item_id=request.task_id,
        cloud_project_id=request.project_id,
        agent=agent,
        assigner_user_id=user_id,
        environment=environment,
        execution_device_id=original.runtime_device_id,
        priority=None,
        automation_context=context,
    )
    execution.executor_owner_user_id = bound.user_id
    execution.runtime_device_id = original.runtime_device_id
    runtime_selection = execution.runtime_selection
    if context.get("dispatch_role") == "manager":
        from app.services.runner_routing import resolve_group_routing

        requirements = resolve_group_routing(
            db,
            group=context["collaboration_group"],
            project_id=request.project_id,
            issue_id=request.task_id,
            user_id=user_id,
            selection=selection,
        )
        runtime_selection = {
            **runtime_selection,
            "group_runner_requirements": requirements,
        }
    intent = RuntimeTaskMaterializeRequest.model_validate(
        original.runtime_request
    ).model_copy(
        update={
            "message": trigger.content,
            "new_session": False,
            "device_id": original.runtime_device_id,
            "local_task_id": original.runtime_task_id,
            "attachment_ids": [],
            "attachments": attachments,
            "origin": {
                **(original.runtime_request.get("origin") or {}),
                **context,
                "type": "board_comment",
                "executionId": execution.id,
            },
        }
    )
    execution.execution_payload = (
        loop_item_execution_service._serialize_execution_intent(
            runtime_selection=runtime_selection,
            origin_context=execution.runtime_origin_context,
            runtime_request=intent.model_dump(by_alias=True, exclude_none=True),
        )
    )
    response = _response(db, request, trigger, agent.id, target.sender_name, execution)
    response.metadata_json = {**response.metadata_json, "run_status": execution.status}
    db.commit()
    return response


@trace_async(tracer_name="project_chat")
async def execute_comment(
    db: Session, *, user_id: int, request: ProjectChatCommentExecution
) -> list[ProjectChatMessageView]:
    project_chat_service._require_scope(
        db,
        user_id=user_id,
        project_id=request.project_id,
        task_id=request.task_id,
        required_role=BaseRole.Developer,
    )
    trigger = (
        _messages(db, request)
        .filter(
            ProjectChatMessage.message_id == request.trigger_message_id,
            ProjectChatMessage.sender_type == "user",
            ProjectChatMessage.sender_id == str(user_id),
        )
        .with_for_update()
        .one_or_none()
    )
    if trigger is None:
        raise HTTPException(404, "The saved comment was not found")
    if (trigger.metadata_json or {}).get("execution_dispatch") == "comment_only":
        return []
    target = _thread_agent(db, request, trigger)
    existing = (
        _messages(db, request)
        .filter(
            ProjectChatMessage.trigger_message_id == trigger.message_id,
            ProjectChatMessage.sender_type == "agent",
        )
        .with_for_update()
        .first()
    )
    if existing is not None:
        if existing.status == "failed":
            raise HTTPException(409, existing.content or "The comment execution failed")
        return [project_chat_service.to_view(existing, db=db)]
    attachments = _attachments(db, user_id, request.attachment_ids)
    if target is None:
        response = _new_execution(db, user_id, request, trigger, attachments)
        return [project_chat_service.to_view(response, db=db)] if response else []
    execution = _execution(db, request, target)
    from app.services.collaboration_revocation import execution_authorized

    authority = LoopItemExecution(
        cloud_project_id=request.project_id,
        loop_item_id=request.task_id,
        assigner_user_id=user_id,
        executor_owner_user_id=execution.executor_owner_user_id,
        agent_id=execution.agent_id,
        team_id=None,
        execution_environment="local",
        execution_device_id=execution.runtime_device_id,
        runtime_device_id=execution.runtime_device_id,
        execution_payload=loop_item_execution_service._serialize_execution_intent(
            runtime_selection={}, origin_context=execution.runtime_origin_context
        ),
    )
    if not execution_authorized(db, authority):
        raise HTTPException(403, "Comment execution authorization is revoked")
    if execution.agent_id:
        project_chat_service._agent_row(
            db,
            project_id=request.project_id,
            agent_id=execution.agent_id,
            active_only=True,
        )
    from app.services.project_chat.service import compiled_bot_config

    current_agent = (
        db.get(ProjectChatAgent, execution.agent_id) if execution.agent_id else None
    )
    routed = current_agent is not None and compiled_bot_config(
        db, current_agent, execution_user_id=user_id
    ).get("execution_policy")
    if (
        routed
        or execution.runtime_origin_context.get("dispatch_kind")
        == "collaboration_group"
        or isinstance(execution, LoopItemExecution)
        and execution.uses_runner_routing
    ):
        response = _queue_reply(
            db, user_id, request, trigger, target, execution, attachments
        )
    else:
        response = await _continue_runtime(
            db, request, trigger, target, execution, attachments
        )
    return [project_chat_service.to_view(response, db=db)]
