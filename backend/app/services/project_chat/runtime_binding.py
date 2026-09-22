# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Resolve manually created comment sessions through their durable TaskBinding."""

from dataclasses import dataclass
from typing import Any

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models.delivery import LoopItemTaskBinding, loop_datetime_is_unset
from app.models.project_chat_message import ProjectChatMessage
from app.schemas.project_chat import ProjectChatCommentExecution


@dataclass(frozen=True)
class BoundCommentSession:
    executor_owner_user_id: int
    runtime_device_id: str
    runtime_task_id: str
    agent_id: str
    runtime_request: dict[str, Any]
    id: None = None
    team_id: int = 0
    executor_type: str = "project_robot"
    automation_run_id: str = ""


def resolve_bound_comment_session(
    db: Session,
    request: ProjectChatCommentExecution,
    target: ProjectChatMessage,
) -> BoundCommentSession:
    binding = (
        db.query(LoopItemTaskBinding)
        .filter(
            LoopItemTaskBinding.cloud_project_id == request.project_id,
            LoopItemTaskBinding.loop_item_id == request.task_id,
            LoopItemTaskBinding.device_id == target.runtime_device_id,
            LoopItemTaskBinding.task_id == target.runtime_task_id,
            loop_datetime_is_unset(LoopItemTaskBinding.unlinked_at),
            loop_datetime_is_unset(LoopItemTaskBinding.deleted_at),
        )
        .one_or_none()
    )
    if binding is None or not binding.task_user_id or not target.agent_id:
        raise HTTPException(409, "The comment has no valid execution binding")
    selection = binding.model_selection or {}
    return BoundCommentSession(
        executor_owner_user_id=binding.task_user_id,
        runtime_device_id=binding.device_id,
        runtime_task_id=binding.task_id,
        agent_id=target.agent_id,
        runtime_request={
            "schemaVersion": 2,
            "runtime": "codex",
            "deviceId": binding.device_id,
            "taskId": binding.task_id,
            "message": "",
            "modelId": selection.get("modelName") or target.metadata_json.get("model"),
            "modelType": selection.get("modelType"),
            "modelOptions": selection.get("options") or {},
            "cloudProjectId": request.project_id,
            "standaloneChatWorkspace": True,
        },
    )
