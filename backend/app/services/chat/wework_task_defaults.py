# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Shared defaults for Wework task execution parameters."""

from __future__ import annotations

import json
import logging
from copy import deepcopy
from dataclasses import dataclass, replace
from typing import Any

from sqlalchemy.orm import Session

from app.core.constants import CLIENT_ORIGIN_WEWORK
from app.models.project import Project
from app.models.task import TaskResource
from app.models.user import User
from app.services.chat.storage.task_manager import TaskCreationParams
from app.services.user_mcp_service import UserMCPService

logger = logging.getLogger(__name__)

WEWORK_NEW_CHAT_MODEL_SELECTION_KEY = "wework_new_chat_model_selection"


@dataclass(frozen=True)
class WeworkModelSelection:
    """Resolved Wework model selection."""

    model_id: str
    model_type: str | None = None
    model_options: dict[str, Any] | None = None


async def apply_wework_task_defaults(
    db: Session,
    *,
    user: User,
    params: TaskCreationParams,
    task: TaskResource | None = None,
) -> TaskCreationParams:
    """Apply Wework model and device defaults to task creation params."""

    if params.client_origin != CLIENT_ORIGIN_WEWORK:
        return params

    resolved = apply_wework_task_model_defaults(user=user, params=params, task=task)
    return await apply_wework_task_device_defaults(
        db,
        user=user,
        params=resolved,
        task=task,
    )


def apply_existing_wework_task_defaults(
    *,
    params: TaskCreationParams,
    task: TaskResource,
) -> TaskCreationParams:
    """Apply defaults that are already persisted on an existing task."""

    if params.client_origin != CLIENT_ORIGIN_WEWORK:
        return params

    selection = extract_task_model_selection(task)
    device_id = extract_task_device_id(task)
    if selection is None and not device_id:
        return params

    return replace(
        params,
        model_id=params.model_id or (selection.model_id if selection else None),
        force_override_bot_model=(
            params.force_override_bot_model or selection is not None
        ),
        force_override_bot_model_type=(
            params.force_override_bot_model_type
            or (selection.model_type if selection else None)
        ),
        model_options=(
            params.model_options
            if params.model_options is not None
            else deepcopy(selection.model_options) if selection else None
        ),
        device_id=params.device_id or device_id,
    )


def apply_wework_task_model_defaults(
    *,
    user: User,
    params: TaskCreationParams,
    task: TaskResource | None = None,
) -> TaskCreationParams:
    """Apply task labels or user Wework model preference to params."""

    if params.client_origin != CLIENT_ORIGIN_WEWORK or params.model_id:
        return params

    selection = extract_task_model_selection(task) or extract_user_model_selection(user)
    if selection is None:
        return params

    return replace(
        params,
        model_id=selection.model_id,
        force_override_bot_model=True,
        force_override_bot_model_type=selection.model_type,
        model_options=deepcopy(selection.model_options),
    )


async def apply_wework_task_device_defaults(
    db: Session,
    *,
    user: User,
    params: TaskCreationParams,
    task: TaskResource | None = None,
) -> TaskCreationParams:
    """Apply task, project, or user selected Wework execution device to params."""

    if params.client_origin != CLIENT_ORIGIN_WEWORK or params.device_id:
        return params

    device_id = (
        extract_task_device_id(task)
        or _extract_project_device_id(db, user.id, params.project_id)
        or await _get_user_selected_device_id(user)
    )
    if not device_id:
        return params

    return replace(params, device_id=device_id)


def extract_task_model_selection(
    task: TaskResource | None,
) -> WeworkModelSelection | None:
    """Extract a Wework model selection from task metadata labels."""

    labels = _task_labels(task)
    model_id = _clean_string(labels.get("modelId"))
    if not model_id:
        return None

    return WeworkModelSelection(
        model_id=model_id,
        model_type=_clean_string(labels.get("forceOverrideBotModelType")),
        model_options=_parse_model_options(labels.get("modelOptions")),
    )


def extract_user_model_selection(user: User) -> WeworkModelSelection | None:
    """Extract the user's default Wework new-task model selection."""

    preferences = UserMCPService.load_preferences(getattr(user, "preferences", None))
    selection = preferences.get(WEWORK_NEW_CHAT_MODEL_SELECTION_KEY)
    if not isinstance(selection, dict):
        return None

    model_id = _clean_string(selection.get("modelName"))
    if not model_id:
        return None

    options = selection.get("options")
    return WeworkModelSelection(
        model_id=model_id,
        model_type=_clean_string(selection.get("modelType")),
        model_options=_normalize_model_options(options),
    )


def extract_task_device_id(task: TaskResource | None) -> str | None:
    """Extract a task execution device id from the Task CRD spec."""

    task_json = getattr(task, "json", None)
    if not isinstance(task_json, dict):
        return None
    spec = task_json.get("spec")
    if not isinstance(spec, dict):
        return None
    return _clean_string(spec.get("device_id"))


def _task_labels(task: TaskResource | None) -> dict[str, Any]:
    task_json = getattr(task, "json", None)
    if not isinstance(task_json, dict):
        return {}
    metadata = task_json.get("metadata")
    if not isinstance(metadata, dict):
        return {}
    labels = metadata.get("labels")
    return labels if isinstance(labels, dict) else {}


def _parse_model_options(raw_options: Any) -> dict[str, Any] | None:
    if isinstance(raw_options, str):
        try:
            parsed = json.loads(raw_options)
        except json.JSONDecodeError:
            return None
        return _normalize_model_options(parsed)
    return _normalize_model_options(raw_options)


def _normalize_model_options(raw_options: Any) -> dict[str, Any] | None:
    if not isinstance(raw_options, dict):
        return None
    options = {
        str(key): value
        for key, value in raw_options.items()
        if key is not None and value is not None
    }
    return options or None


def _extract_project_device_id(
    db: Session,
    user_id: int,
    project_id: int | None,
) -> str | None:
    if not project_id:
        return None

    project = (
        db.query(Project)
        .filter(
            Project.id == project_id,
            Project.user_id == user_id,
            Project.client_origin == CLIENT_ORIGIN_WEWORK,
            Project.is_active == True,
        )
        .first()
    )
    if project is None or not isinstance(project.config, dict):
        return None

    execution = project.config.get("execution")
    if isinstance(execution, dict):
        device_id = _clean_string(execution.get("deviceId"))
        if device_id:
            return device_id

    return _clean_string(project.config.get("device_id"))


async def _get_user_selected_device_id(user: User) -> str | None:
    try:
        from app.services.channels.device_selection import (
            DeviceType,
            device_selection_manager,
        )

        selection = await device_selection_manager.get_selection(user.id)
    except Exception as exc:
        logger.warning(
            "[WeworkTaskDefaults] Failed to load device selection for user %s: %s",
            user.id,
            exc,
        )
        return _get_default_execution_target_device_id(user)

    if selection.device_type == DeviceType.LOCAL:
        return _clean_string(selection.device_id)
    if selection.device_type == DeviceType.CLOUD:
        return None
    return _get_default_execution_target_device_id(user)


def _get_default_execution_target_device_id(user: User) -> str | None:
    preferences = UserMCPService.load_preferences(getattr(user, "preferences", None))
    default_target = _clean_string(preferences.get("default_execution_target"))
    if not default_target or default_target == "cloud":
        return None
    return default_target


def _clean_string(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    cleaned = value.strip()
    return cleaned or None
