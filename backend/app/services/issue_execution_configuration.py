# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Resolve robot defaults into an Issue-owned execution snapshot."""

from typing import Any

from sqlalchemy.orm import Session

from app.models.delivery import ProjectChatAgent, RuntimeProfile
from app.schemas.issue_workflow import WorkflowExecutionConfig
from app.schemas.project_chat import ProjectChatWorkspaceBinding
from app.services.project_chat.service import bot_config
from app.services.project_chat.workspace_binding import read_agent_workspace_binding


def project_robot_execution_config(
    db: Session, agent: ProjectChatAgent
) -> WorkflowExecutionConfig:
    config = bot_config(agent)
    runtime_profile_id = str(config.get("default_runtime_profile_id") or "") or None
    runtime_profile = (
        db.get(RuntimeProfile, runtime_profile_id) if runtime_profile_id else None
    )
    profile_metadata = (
        dict(runtime_profile.metadata_json or {}) if runtime_profile else {}
    )
    binding = read_agent_workspace_binding(db, agent=agent)
    workspace_binding = None
    if binding.status == "ready" and binding.type in {
        "backend_project",
        "device_project",
        "standalone",
    }:
        workspace_binding = ProjectChatWorkspaceBinding.model_validate(
            {
                "type": binding.type,
                "projectId": binding.project_id,
                "deviceWorkspaceId": binding.device_workspace_id,
                "deviceId": binding.device_id,
                "runtimeProjectKey": binding.runtime_project_key,
            }
        )
    return WorkflowExecutionConfig(
        agent_id=agent.id,
        runtime_profile_id=runtime_profile_id,
        execution_device_id=str(
            (
                runtime_profile.device_id
                if runtime_profile is not None
                else config.get("execution_device_id")
            )
            or ""
        )
        or None,
        model=str(profile_metadata.get("model") or config.get("model") or "") or None,
        workspace_binding=workspace_binding,
    )


def execution_context(
    config: WorkflowExecutionConfig,
    *,
    runtime_subject_user_id: int,
) -> dict[str, Any]:
    return {
        "runtime_source": (
            "fixed_profile" if config.runtime_profile_id else "agent_default"
        ),
        "runtime_profile_id": config.runtime_profile_id,
        "runtime_subject_user_id": runtime_subject_user_id,
        "agent_id": config.agent_id,
        "execution_device_id": config.execution_device_id,
        "model": config.model,
        "workspace_binding": (
            config.workspace_binding.model_dump(mode="json", by_alias=True)
            if config.workspace_binding
            else None
        ),
    }
