# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Shared task and model resolution for generation MCP tools."""

from dataclasses import dataclass
from typing import Any

from sqlalchemy.orm import Session

from app.core.config import settings
from app.mcp_server.auth import TaskTokenInfo
from app.models.kind import Kind
from app.models.subtask import Subtask
from app.models.task import TaskResource
from app.models.user import User
from app.schemas.kind import Task
from app.services.execution.request_builder import TaskRequestBuilder
from app.services.model_aggregation_service import model_aggregation_service
from app.stores.tasks import subtask_store, task_store
from shared.models import ExecutionRequest


@dataclass(frozen=True)
class GenerationContext:
    user: User
    task: TaskResource
    subtask: Subtask
    team: Kind
    model_config: dict[str, Any]


def resolve_generation_context(
    db: Session,
    token_info: TaskTokenInfo,
    prompt: str,
) -> GenerationContext:
    """Resolve the authenticated task, subtask, team, and current model."""
    user = db.query(User).filter(User.id == token_info.user_id).first()
    if not user:
        raise ValueError("User not found")

    task = task_store.get_non_deleted_task(
        db,
        task_id=token_info.task_id,
        owner_user_id=token_info.user_id,
    )
    if not task:
        raise ValueError(f"Task not found: {token_info.task_id}")

    subtask = subtask_store.get_basic_by_id(
        db,
        subtask_id=token_info.subtask_id,
        owner_user_id=token_info.user_id,
    )
    if not subtask or subtask.task_id != task.id:
        raise ValueError(f"Subtask not found: {token_info.subtask_id}")

    task_crd = Task.model_validate(task.json or {})
    team_ref = task_crd.spec.teamRef
    team_owner_id = team_ref.user_id if team_ref.user_id is not None else task.user_id
    team = (
        db.query(Kind)
        .filter(
            Kind.user_id == team_owner_id,
            Kind.kind == "Team",
            Kind.name == team_ref.name,
            Kind.namespace == team_ref.namespace,
            Kind.is_active.is_(True),
        )
        .first()
    )
    if not team:
        raise ValueError(
            f"Team not found: {team_ref.namespace}/{team_ref.name} (task={task.id})"
        )

    labels = (task.json or {}).get("metadata", {}).get("labels", {})
    request = _build_request(
        db=db,
        context=(user, task, subtask, team),
        prompt=prompt,
        override_model_name=labels.get("modelId"),
        force_override=labels.get("forceOverrideBotModel") == "true",
    )
    return GenerationContext(
        user=user,
        task=task,
        subtask=subtask,
        team=team,
        model_config=dict(request.model_config or {}),
    )


def resolve_generation_model(
    db: Session,
    context: GenerationContext,
    prompt: str,
    model_type: str,
) -> dict[str, Any]:
    """Resolve the current, configured default, or first available model."""
    if context.model_config.get("modelType") == model_type:
        return dict(context.model_config)

    models = model_aggregation_service.list_available_models(
        db=db,
        current_user=context.user,
        scope="all",
        include_config=False,
        model_category_type=model_type,
    )
    default_model_name = _get_default_generation_model_name(model_type)
    if default_model_name:
        model_name = next(
            (
                model.get("name")
                for model in models
                if model.get("name") == default_model_name
            ),
            None,
        )
        if not model_name:
            raise ValueError(
                f"Configured default {model_type} model "
                f"'{default_model_name}' is not available"
            )
    else:
        priority = {"user": 0, "group": 1, "public": 2, "runtime": 3}
        candidates = sorted(
            models,
            key=lambda model: (
                priority.get(str(model.get("type", "")).lower(), 9),
                str(model.get("name", "")),
            ),
        )
        model_name = next(
            (
                model.get("name")
                for model in candidates
                if isinstance(model.get("name"), str) and model.get("name")
            ),
            None,
        )
    if not model_name:
        raise ValueError(
            f"No available {model_type} model was found. "
            f"Please configure a {model_type} model and retry."
        )

    request = _build_request(
        db=db,
        context=(context.user, context.task, context.subtask, context.team),
        prompt=prompt,
        override_model_name=model_name,
        force_override=True,
    )
    model_config = dict(request.model_config or {})
    if model_config.get("modelType") != model_type:
        raise ValueError(f"Model '{model_name}' is not a {model_type} model")
    return model_config


def _get_default_generation_model_name(model_type: str) -> str:
    if model_type == "image":
        return settings.DEFAULT_IMAGE_GENERATION_MODEL.strip()
    if model_type == "video":
        return settings.DEFAULT_VIDEO_GENERATION_MODEL.strip()
    return ""


def _build_request(
    *,
    db: Session,
    context: tuple[User, TaskResource, Subtask, Kind],
    prompt: str,
    override_model_name: str | None,
    force_override: bool,
) -> ExecutionRequest:
    user, task, subtask, team = context
    return TaskRequestBuilder(db).build(
        subtask=subtask,
        task=task,
        user=user,
        team=team,
        message=prompt,
        enable_tools=False,
        enable_web_search=False,
        enable_clarification=False,
        enable_deep_thinking=False,
        override_model_name=override_model_name,
        force_override=force_override,
    )
