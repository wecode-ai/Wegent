# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Resolve robot defaults into an Issue-owned execution snapshot."""

from typing import Any

from sqlalchemy.orm import Session

from app.models.delivery import ProjectAutomationRule, ProjectChatAgent, RuntimeProfile
from app.schemas.issue_workflow import WorkflowExecutionConfig
from app.schemas.project_chat import ProjectChatWorkspaceBinding
from app.services.project_automation_domain import manager_type, runtime_config
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
    model_from_profile = bool(profile_metadata.get("model"))
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
        model_type=(
            profile_metadata.get("model_type")
            if model_from_profile
            else config.get("model_type")
        ),
        model_options=dict(
            (
                profile_metadata.get("model_options")
                if model_from_profile
                else config.get("model_options")
            )
            or {}
        ),
        workspace_binding=workspace_binding,
        runtime_permission_mode=(
            profile_metadata.get("runtime_permission_mode")
            or config.get("runtime_permission_mode")
        ),
        execution=profile_metadata.get("execution") or config.get("execution"),
        initial_goal=profile_metadata.get("initial_goal") or config.get("initial_goal"),
        initial_supervisor=(
            profile_metadata.get("initial_supervisor")
            or config.get("initial_supervisor")
        ),
        additional_skills=(
            profile_metadata.get("additional_skills") or config.get("additional_skills")
        ),
        attachment_ids=(
            profile_metadata.get("attachment_ids") or config.get("attachment_ids")
        ),
        attachments=profile_metadata.get("attachments") or config.get("attachments"),
        project_plugins=(
            profile_metadata.get("project_plugins") or config.get("project_plugins")
        ),
        additional_context=(
            profile_metadata.get("additional_context")
            or config.get("additional_context")
        ),
        ephemeral=(
            profile_metadata.get("ephemeral")
            if "ephemeral" in profile_metadata
            else config.get("ephemeral")
        ),
    )


def project_automation_execution_config(
    db: Session,
    rule: ProjectAutomationRule,
    *,
    issue_creator_user_id: int,
) -> WorkflowExecutionConfig | None:
    """Snapshot the AI manager Runtime without starting the manager."""

    metadata = dict(rule.metadata_json or {})
    if manager_type(metadata) == "wegent":
        return None
    runtime = runtime_config(metadata)
    runtime_source = str(runtime.get("source") or "")
    runtime_user_id = int(rule.created_by_user_id or issue_creator_user_id)
    if runtime_source == "issue_creator":
        runtime_user_id = issue_creator_user_id
    elif runtime_source == "runtime_user":
        runtime_user_id = int(runtime.get("user_id") or runtime_user_id)

    profile_id = str(runtime.get("runtime_profile_id") or "") or None
    profile = db.get(RuntimeProfile, profile_id) if profile_id else None
    if runtime_source in {"issue_creator", "runtime_user"}:
        from app.services.runtime_profiles import runtime_profile_service

        profile = runtime_profile_service.resolve_project_default(
            db,
            str(rule.cloud_project_id),
            runtime_user_id,
        )
        profile_id = str(profile.id) if profile is not None else None

    profile_metadata = dict(profile.metadata_json or {}) if profile is not None else {}
    return WorkflowExecutionConfig(
        runtime_profile_id=profile_id,
        execution_device_id=(
            str(profile.device_id or "") or None if profile is not None else None
        ),
        model=str(profile_metadata.get("model") or "") or None,
        model_type=profile_metadata.get("model_type"),
        model_options=dict(profile_metadata.get("model_options") or {}),
        workspace_binding=ProjectChatWorkspaceBinding(type="standalone"),
    )


def execution_context(
    config: WorkflowExecutionConfig,
    *,
    runtime_subject_user_id: int,
) -> dict[str, Any]:
    return {
        "runtime_source": (
            "fixed_profile" if config.runtime_profile_id else "issue_snapshot"
        ),
        "runtime_profile_id": config.runtime_profile_id,
        "runtime_subject_user_id": runtime_subject_user_id,
        "agent_id": config.agent_id,
        "execution_device_id": config.execution_device_id,
        "model": config.model,
        "model_type": config.model_type,
        "model_options": config.model_options,
        "workspace_binding": (
            config.workspace_binding.model_dump(mode="json", by_alias=True)
            if config.workspace_binding
            else None
        ),
        **config.runtime_request_options(),
    }
