# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Transient Wework runtime profile compilation.

Project robot configuration and custom automation configuration both remain in
their canonical records. This module compiles those live values into a runtime
request only when an execution is claimed.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.models.delivery import (
    CloudProject,
    CloudProjectLocalBinding,
    ProjectChatAgent,
    RuntimeProfile,
    loop_datetime_is_unset,
)
from app.models.user import User
from app.schemas.project_chat import ProjectChatWorkspaceBindingView
from app.schemas.runtime_work import RuntimeName, RuntimeTaskCreateRequest
from app.services.project_chat.workspace_binding import (
    adapt_legacy_workspace_binding,
    read_agent_workspace_binding,
)
from app.services.workspaces.storage import get_workspace_kind, workspace_id_for_project


class WeworkExecutionProfileError(ValueError):
    """One canonical runtime profile cannot be materialized."""


def _execution_environment_config(
    db: Session,
    project: CloudProject,
) -> dict[str, Any]:
    """Compile Workspace defaults and Project overrides into one Run snapshot."""

    workspace_config: dict[str, Any] = {}
    workspace_id = workspace_id_for_project(db, project.id)
    if workspace_id is not None:
        workspace = get_workspace_kind(db, workspace_id)
        payload = workspace.json if workspace is not None else {}
        spec = payload.get("spec") if isinstance(payload, dict) else {}
        candidate = spec.get("executionEnvironment") if isinstance(spec, dict) else {}
        if isinstance(candidate, dict):
            workspace_config = candidate

    metadata = project.metadata_json if isinstance(project.metadata_json, dict) else {}
    candidate = metadata.get("execution_environment")
    project_config = candidate if isinstance(candidate, dict) else {}
    selected_config = project_config if project_config else workspace_config
    selected_repositories = selected_config.get("repositories")
    repositories = [
        {
            "name": str(repository.get("name") or "").strip(),
            "url": str(repository.get("url") or "").strip(),
            "ref": str(repository.get("ref") or "").strip(),
            "path": str(repository.get("path") or "").strip(),
            "primary": bool(repository.get("primary")),
        }
        for repository in (
            selected_repositories if isinstance(selected_repositories, list) else []
        )
        if isinstance(repository, dict)
        and str(repository.get("url") or "").strip()
        and str(repository.get("path") or "").strip()
    ]
    selected_steps = selected_config.get("setup_steps")
    setup_steps = [
        {
            "command": str(step.get("command") or "").strip(),
            "workingDirectory": str(step.get("working_directory") or "").strip(),
        }
        for step in (selected_steps if isinstance(selected_steps, list) else [])
        if isinstance(step, dict) and str(step.get("command") or "").strip()
    ]
    devices = selected_config.get("devices")
    return {
        "repositories": repositories,
        "setup_steps": setup_steps,
        "fingerprint": selected_config.get("fingerprint"),
        "devices": (
            {
                str(key): value
                for key, value in devices.items()
                if isinstance(value, dict)
            }
            if isinstance(devices, dict)
            else {}
        ),
    }


def _merge_environment_execution(
    execution: dict[str, Any] | None,
    environment: dict[str, Any],
) -> dict[str, Any] | None:
    """Merge immutable environment preparation into the existing execution intent."""

    merged = dict(execution or {})
    repositories = environment.get("repositories")
    if isinstance(repositories, list) and repositories:
        workspace = (
            dict(merged.get("workspace"))
            if isinstance(merged.get("workspace"), dict)
            else {}
        )
        workspace["repositories"] = list(repositories)
        merged["workspace"] = workspace
    setup_steps = environment.get("setup_steps")
    if isinstance(setup_steps, list) and setup_steps:
        setup = (
            dict(merged.get("setup")) if isinstance(merged.get("setup"), dict) else {}
        )
        setup["steps"] = list(setup_steps)
        setup["fingerprint"] = str(environment.get("fingerprint") or "")
        merged["setup"] = setup
    return merged or None


def native_runtime_contract(runtime: object) -> tuple[RuntimeName, str]:
    """Return the exact Runtime and shell pair for a native project agent."""

    if runtime == "codex":
        return "codex", "Codex"
    if runtime == "claude_code":
        return "claude_code", "ClaudeCode"
    raise WeworkExecutionProfileError(
        f"Project robot runtime '{runtime}' is not a native device runtime"
    )


def build_project_robot_user_input(
    *,
    project_id: str,
    task_id: str,
    execution_id: int,
    execution_prompt: str,
    stage_instruction: str = "",
) -> str:
    """Build the one visible user input shared by every robot runtime."""

    task_url = f"cloud://projects/{project_id}/todos/{task_id}"
    sections = [
        (
            f"project_id: {project_id}\n"
            f"task_id: {task_id}\n"
            f"execution_id: {execution_id}"
        ),
        f"看板任务数据位于 {task_url}，请通过看板工具自行查看。",
    ]
    normalized_prompt = execution_prompt.strip()
    normalized_stage_instruction = stage_instruction.strip()
    if normalized_stage_instruction:
        sections.append(normalized_stage_instruction)
    elif normalized_prompt:
        sections.append(normalized_prompt)
    return "\n\n".join(sections)


def inherited_workflow_workspace_source(
    origin_context: dict[str, Any],
) -> dict[str, str] | None:
    """Return the latest predecessor Runtime task for an inherited stage."""

    workflow_stage_input = origin_context.get("workflow_stage_input")
    if not isinstance(workflow_stage_input, dict):
        return None
    target_stage = workflow_stage_input.get("target_stage")
    if (
        not isinstance(target_stage, dict)
        or target_stage.get("workspace_policy") != "inherit"
    ):
        return None
    dependencies = workflow_stage_input.get("dependencies")
    for dependency in reversed(dependencies if isinstance(dependencies, list) else []):
        if not isinstance(dependency, dict):
            continue
        runtime_tasks = dependency.get("runtime_tasks")
        for source in reversed(
            runtime_tasks if isinstance(runtime_tasks, list) else []
        ):
            if not isinstance(source, dict):
                continue
            device_id = str(source.get("device_id") or "")
            source_task_id = str(source.get("task_id") or "")
            if device_id and source_task_id:
                return {"deviceId": device_id, "taskId": source_task_id}
    return None


def validate_wework_execution_target(
    db: Session,
    *,
    user_id: int,
    environment: str,
    execution_device_id: str | None,
) -> None:
    """Validate that one Wework target belongs to its owner and matches type."""

    if environment not in {"local", "cloud"}:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "Execution environment must be local or cloud",
        )
    if not execution_device_id:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "Wework execution must bind an execution device",
        )

    from app.services.device_service import device_service

    device = device_service.get_device_by_device_id(
        db, user_id=user_id, device_id=execution_device_id
    )
    if device is None:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "Execution device not found",
        )
    actual_type = (device.json or {}).get("spec", {}).get("deviceType", "local")
    expected = {"local": {"local", "app"}, "cloud": {"cloud", "remote"}}
    if actual_type not in expected[environment]:
        expected_label = "local" if environment == "local" else "cloud"
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            f"Device '{execution_device_id}' is type '{actual_type}', "
            f"expected a {expected_label} device",
        )


def wework_execution_environment(
    db: Session,
    *,
    user_id: int,
    execution_device_id: str,
) -> str:
    """Resolve the queue partition from the selected device itself."""

    from app.services.device_service import device_service

    device = device_service.get_device_by_device_id(
        db, user_id=user_id, device_id=execution_device_id
    )
    if device is None:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "Execution device not found",
        )
    device_type = (device.json or {}).get("spec", {}).get("deviceType", "local")
    if device_type in {"local", "app"}:
        return "local"
    if device_type in {"cloud", "remote"}:
        return "cloud"
    raise HTTPException(
        status.HTTP_422_UNPROCESSABLE_ENTITY,
        f"Unsupported execution device type '{device_type}'",
    )


@dataclass(frozen=True)
class WeworkExecutionProfile:
    """Live, non-persistent inputs for one Wework runtime request."""

    owner_user_id: int
    display_name: str
    execution_prompt: str
    instruction: str
    system_prompt: str = ""
    runtime: RuntimeName = "codex"
    model: str = ""
    model_type: str | None = None
    model_options: dict[str, str] | None = None
    agent_id: str = ""
    local_project_id: int = 0
    max_concurrent_executions: int = 1
    manager_mode: bool = False
    workspace_policy: str = "project"
    plugins: tuple[dict[str, str], ...] = ()
    additional_skills: tuple[Any, ...] = ()
    mcp_servers: dict[str, Any] | None = None
    workspace_binding_override: ProjectChatWorkspaceBindingView | None = None

    @classmethod
    def for_project_robot(
        cls,
        agent: ProjectChatAgent,
        *,
        db: Session | None = None,
        runtime_profile: RuntimeProfile | None = None,
        cloud_project_id: str | None = None,
        model_override: str = "",
        model_type_override: str | None = None,
        model_options_override: dict[str, str] | None = None,
        workspace_binding_override: dict[str, Any] | None = None,
    ) -> "WeworkExecutionProfile":
        from app.services.project_chat.service import (
            bot_config,
            bot_max_concurrent_executions,
            compiled_bot_config,
        )

        profile_metadata = (
            dict(runtime_profile.metadata_json or {}) if runtime_profile else {}
        )
        owner_user_id = int(
            runtime_profile.user_id
            if runtime_profile is not None
            else agent.created_by_user_id or 0
        )
        config = (
            compiled_bot_config(
                db,
                agent,
                execution_user_id=owner_user_id,
            )
            if db is not None
            else bot_config(agent)
        )
        local_project_id = int(agent.local_project_id or 0)
        if db is not None and runtime_profile is not None and cloud_project_id:
            binding = (
                db.query(CloudProjectLocalBinding)
                .filter(
                    CloudProjectLocalBinding.cloud_project_id == str(cloud_project_id),
                    CloudProjectLocalBinding.user_id == owner_user_id,
                    CloudProjectLocalBinding.device_id
                    == str(runtime_profile.device_id or ""),
                    CloudProjectLocalBinding.status == "active",
                    loop_datetime_is_unset(CloudProjectLocalBinding.deleted_at),
                )
                .order_by(CloudProjectLocalBinding.updated_at.desc())
                .first()
            )
            local_project_id = int(binding.local_project_id or 0) if binding else 0
        return cls(
            owner_user_id=owner_user_id,
            display_name=str(agent.title or agent.name or "AI"),
            execution_prompt="",
            instruction="",
            system_prompt=str(config.get("system_prompt") or ""),
            runtime=native_runtime_contract(config["runtime"])[0],
            model=str(
                model_override
                or profile_metadata.get("model")
                or config.get("model")
                or ""
            ),
            model_type=(
                model_type_override
                or profile_metadata.get("model_type")
                or config.get("model_type")
            ),
            model_options=dict(
                model_options_override
                or profile_metadata.get("model_options")
                or config.get("model_options")
                or {}
            ),
            agent_id=agent.id,
            local_project_id=local_project_id,
            max_concurrent_executions=bot_max_concurrent_executions(agent),
            workspace_policy=str(
                profile_metadata.get("workspace_policy")
                or config.get("workspace_policy")
                or "project"
            ),
            plugins=tuple(
                plugin
                for plugin in config.get("plugins", [])
                if isinstance(plugin, dict)
            ),
            additional_skills=tuple(config.get("additional_skills") or []),
            mcp_servers=dict(config.get("mcp_servers") or {}),
            workspace_binding_override=(
                ProjectChatWorkspaceBindingView.model_validate(
                    {
                        **workspace_binding_override,
                        "status": "ready",
                    }
                )
                if workspace_binding_override
                else None
            ),
        )

    @classmethod
    def for_automation_manager(
        cls,
        *,
        owner_user_id: int,
        display_name: str,
        instruction: str,
        system_prompt: str,
        model: str,
        model_type: str | None = None,
        model_options: dict[str, str] | None = None,
        local_project_id: int = 0,
    ) -> "WeworkExecutionProfile":
        if not model:
            raise ValueError("Custom AI manager model is required")
        return cls(
            owner_user_id=owner_user_id,
            display_name=display_name or "AI 托管",
            execution_prompt="",
            instruction=instruction,
            system_prompt=system_prompt,
            model=model,
            model_type=model_type,
            model_options=dict(model_options or {}),
            local_project_id=local_project_id,
            manager_mode=True,
        )

    @classmethod
    def for_generic_robot(
        cls,
        *,
        runtime_profile: RuntimeProfile | None,
        owner_user_id: int,
        display_name: str,
        execution_prompt: str,
        model_override: str = "",
        model_type_override: str | None = None,
        model_options_override: dict[str, str] | None = None,
        local_project_id: int = 0,
        workspace_binding_override: dict[str, Any] | None = None,
    ) -> "WeworkExecutionProfile":
        metadata = dict(runtime_profile.metadata_json or {}) if runtime_profile else {}
        model = str(model_override or metadata.get("model") or "")
        return cls(
            owner_user_id=owner_user_id,
            display_name=display_name or "AI",
            execution_prompt=execution_prompt,
            instruction="",
            model=model,
            model_type=model_type_override or metadata.get("model_type"),
            model_options=dict(
                model_options_override or metadata.get("model_options") or {}
            ),
            local_project_id=local_project_id,
            workspace_policy=str(metadata.get("workspace_policy") or "project"),
            workspace_binding_override=(
                ProjectChatWorkspaceBindingView.model_validate(
                    {
                        **workspace_binding_override,
                        "status": "ready",
                    }
                )
                if workspace_binding_override
                else None
            ),
        )

    def user_input(
        self,
        *,
        project_id: str,
        task_id: str,
        execution_id: int,
        workflow_stage_input: dict[str, Any] | None = None,
    ) -> str:
        if self.manager_mode:
            return self.instruction.strip()
        from app.services.workflow_stage_context import compiled_workflow_stage_input

        stage_instruction = (
            str(
                compiled_workflow_stage_input(workflow_stage_input).get(
                    "compiled_task_instruction"
                )
                or ""
            )
            if workflow_stage_input
            else ""
        )
        return build_project_robot_user_input(
            project_id=project_id,
            task_id=task_id,
            execution_id=execution_id,
            execution_prompt=self.execution_prompt,
            stage_instruction=stage_instruction,
        )

    def build_runtime_request(
        self,
        db: Session,
        *,
        execution_id: int,
        runtime_task_id: str,
        task: Any,
        cloud_project_id: str,
        origin_context: dict[str, Any],
        execution_device_id: str = "",
    ) -> RuntimeTaskCreateRequest:
        """Build the canonical V2 intent consumed by either Runtime compiler."""

        owner = db.get(User, self.owner_user_id)
        project = db.get(CloudProject, cloud_project_id)
        if owner is None or project is None:
            raise ValueError("Wework execution owner or project is unavailable")
        task_id = str(getattr(task, "id", ""))
        if self.workspace_binding_override is not None:
            workspace_binding = self.workspace_binding_override
        elif self.agent_id:
            agent = db.get(ProjectChatAgent, self.agent_id)
            if agent is None:
                raise WeworkExecutionProfileError(
                    f"Project robot '{self.agent_id}' is unavailable"
                )
            workspace_binding = read_agent_workspace_binding(db, agent=agent)
        else:
            workspace_binding = adapt_legacy_workspace_binding(
                db,
                user_id=owner.id,
                environment=wework_execution_environment(
                    db,
                    user_id=owner.id,
                    execution_device_id=execution_device_id,
                ),
                execution_device_id=execution_device_id,
                local_project_id=self.local_project_id,
            )
        if workspace_binding.status != "ready":
            raise WeworkExecutionProfileError(
                "Robot workspace binding is ambiguous; select an exact workspace"
            )
        has_bound_workspace = workspace_binding.type == "device_project"
        if workspace_binding.type == "backend_project":
            has_bound_workspace = workspace_binding.device_workspace_id is not None
            if not has_bound_workspace:
                has_bound_workspace = (
                    wework_execution_environment(
                        db,
                        user_id=owner.id,
                        execution_device_id=execution_device_id,
                    )
                    != "cloud"
                )
        workflow_stage_input = origin_context.get("workflow_stage_input")
        workspace_policy = ""
        workspace_source_task = inherited_workflow_workspace_source(origin_context)
        if isinstance(workflow_stage_input, dict):
            target_stage = workflow_stage_input.get("target_stage")
            if isinstance(target_stage, dict):
                workspace_policy = str(
                    target_stage.get("workspace_policy") or "composer"
                )
            if workspace_policy == "inherit":
                if workspace_source_task is None:
                    raise WeworkExecutionProfileError(
                        "Inherited workflow workspace has no predecessor Runtime task"
                    )
                workspace_binding = ProjectChatWorkspaceBindingView(
                    type="standalone",
                    status="ready",
                )
                has_bound_workspace = False
        prompt = self.user_input(
            project_id=str(project.id),
            task_id=task_id,
            execution_id=execution_id,
            workflow_stage_input=(
                workflow_stage_input if isinstance(workflow_stage_input, dict) else None
            ),
        )
        if origin_context.get("comment_trigger_message_id"):
            prompt = str(origin_context["comment_prompt"])
        title = str(getattr(task, "title", "") or "")
        bot_id: int | str = self.agent_id or 0
        origin = {
            **origin_context,
            "type": (
                "board_comment"
                if origin_context.get("comment_trigger_message_id")
                else "project_automation" if self.manager_mode else "board_task"
            ),
            "cloudProjectId": str(project.id),
            "loopItemId": str(getattr(task, "id", "")),
            "executionId": execution_id,
            "taskUrl": (
                f"cloud://projects/{project.id}/todos/"
                f"{str(getattr(task, 'id', ''))}"
            ),
        }
        if isinstance(workflow_stage_input, dict):
            target_stage = workflow_stage_input.get("target_stage")
            if isinstance(target_stage, dict):
                workflow_stage_id = str(target_stage.get("id") or "")
                origin["workflowStageId"] = workflow_stage_id
                origin["workflowStageName"] = str(
                    target_stage.get("name") or workflow_stage_id
                )
        origin["workspacePolicy"] = workspace_policy or self.workspace_policy
        if self.manager_mode:
            origin["automationRole"] = "manager"
        configured_runtime = origin_context.get("runtime")
        runtime, shell_type = native_runtime_contract(
            configured_runtime if configured_runtime is not None else self.runtime
        )
        configured_mcp_servers = origin_context.get("mcp_servers")
        mcp_servers = (
            configured_mcp_servers
            if configured_mcp_servers is not None
            else self.mcp_servers or {}
        )
        if not isinstance(mcp_servers, dict):
            raise WeworkExecutionProfileError(
                "Project robot MCP servers must be an object"
            )
        bot = [
            {
                "id": bot_id,
                "name": self.display_name,
                "shell_type": shell_type,
                "mcp_servers": [
                    {"name": name, **server}
                    for name, server in mcp_servers.items()
                    if isinstance(server, dict)
                ],
            }
        ]
        configured_additional_context = origin_context.get("additional_context")
        additional_context: dict[str, dict[str, Any]] = (
            dict(configured_additional_context)
            if isinstance(configured_additional_context, dict)
            else {}
        )
        if isinstance(workflow_stage_input, dict):
            additional_context["workflowStageInput"] = {
                "kind": "application",
                "value": "\n".join(
                    [
                        "<workflow_stage_input>",
                        json.dumps(workflow_stage_input, ensure_ascii=False),
                        "</workflow_stage_input>",
                        (
                            "This immutable snapshot is the input for the current "
                            "workflow stage. Fulfill every required deliverable by "
                            "its requirement ID before completing the task."
                        ),
                    ]
                ),
            }

        configured_execution = origin_context.get("execution")
        environment_config = _execution_environment_config(db, project)
        device_states = environment_config["devices"]
        # A configured environment only runs on devices that finished preparing
        # it; every other device stops at preflight so it never clones a fresh
        # copy outside the prepared workspace.
        environment_configured = bool(
            environment_config["repositories"]
            or environment_config["fingerprint"]
            or device_states
        )
        environment_workspace_path = ""
        if environment_configured:
            device_state = device_states.get(execution_device_id)
            device_state = device_state if isinstance(device_state, dict) else {}
            if str(device_state.get("status") or "") != "ready":
                raise WeworkExecutionProfileError(
                    "Project execution environment is not ready"
                )
            environment_workspace_path = str(device_state.get("workspace_path") or "")
        environment_uses_worktree = bool(
            environment_workspace_path and environment_config.get("repositories")
        )
        generated_execution = (
            {"workspace": {"source": "git_worktree"}}
            if environment_uses_worktree
            or (
                (has_bound_workspace or workspace_source_task)
                and self.workspace_policy == "git_worktree"
            )
            else None
        )
        execution = _merge_environment_execution(
            (
                configured_execution
                if isinstance(configured_execution, dict)
                else generated_execution
            ),
            environment_config,
        )
        origin["executionEnvironment"] = environment_config
        configured_plugins = origin_context.get("project_plugins")
        configured_system_prompt = origin_context.get("system_prompt")
        request = RuntimeTaskCreateRequest(
            schemaVersion=2,
            taskId=runtime_task_id,
            runtime=runtime,
            message=prompt,
            title=title,
            modelId=self.model or None,
            modelType=self.model_type,
            modelOptions=self.model_options or {},
            modelSelection=(
                {
                    "modelName": self.model,
                    "modelType": self.model_type,
                    "options": self.model_options or {},
                }
                if self.model
                else None
            ),
            projectInstructions=(
                str(configured_system_prompt)
                if configured_system_prompt is not None
                else self.system_prompt
            ),
            bot=bot,
            cloudProjectId=str(project.id),
            projectId=(
                workspace_binding.project_id
                if workspace_binding.type == "backend_project"
                else None
            ),
            deviceWorkspaceId=workspace_binding.device_workspace_id,
            workspacePath=environment_workspace_path or None,
            deviceId=execution_device_id or None,
            runtimeProjectKey=(
                workspace_binding.runtime_project_key
                if workspace_binding.type == "device_project"
                else None
            ),
            origin=origin,
            standaloneChatWorkspace=(
                not has_bound_workspace
                and workspace_source_task is None
                and not environment_workspace_path
            ),
            workspaceSourceTask=workspace_source_task,
            additionalContext=additional_context,
            projectPlugins=(
                configured_plugins
                if isinstance(configured_plugins, list)
                else list(self.plugins)
            ),
            runtimePermissionMode=origin_context.get("runtime_permission_mode"),
            execution=(execution),
            initialGoal=origin_context.get("initial_goal"),
            initialSupervisor=origin_context.get("initial_supervisor"),
            additionalSkills=(
                origin_context.get("additional_skills")
                if origin_context.get("additional_skills") is not None
                else list(self.additional_skills)
            ),
            attachmentIds=origin_context.get("attachment_ids") or [],
            attachments=origin_context.get("attachments") or [],
            ephemeral=origin_context.get("ephemeral"),
        )
        return request
