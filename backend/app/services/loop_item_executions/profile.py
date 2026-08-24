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
from app.schemas.runtime_work import RuntimeTaskCreateRequest
from app.services.project_chat.workspace_binding import (
    adapt_legacy_workspace_binding,
    read_agent_workspace_binding,
)


class WeworkExecutionProfileError(ValueError):
    """One canonical runtime profile cannot be materialized."""


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
    if normalized_prompt:
        sections.append(normalized_prompt)
    return "\n\n".join(sections)


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


@dataclass(frozen=True)
class WeworkExecutionProfile:
    """Live, non-persistent inputs for one Wework runtime request."""

    owner_user_id: int
    display_name: str
    execution_prompt: str
    instruction: str
    model: str = ""
    agent_id: str = ""
    local_project_id: int = 0
    max_concurrent_executions: int = 1
    manager_mode: bool = False
    workspace_policy: str = "project"
    plugins: tuple[dict[str, str], ...] = ()
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
        workspace_binding_override: dict[str, Any] | None = None,
    ) -> "WeworkExecutionProfile":
        from app.services.project_chat.service import (
            bot_config,
            bot_max_concurrent_executions,
        )

        config = bot_config(agent)
        profile_metadata = (
            dict(runtime_profile.metadata_json or {}) if runtime_profile else {}
        )
        owner_user_id = int(
            runtime_profile.user_id
            if runtime_profile is not None
            else agent.created_by_user_id or 0
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
            execution_prompt=str(config.get("execution_prompt") or ""),
            instruction="",
            model=str(
                model_override
                or profile_metadata.get("model")
                or config.get("model")
                or ""
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
        model: str,
        local_project_id: int = 0,
    ) -> "WeworkExecutionProfile":
        if not model:
            raise ValueError("Custom AI manager model is required")
        return cls(
            owner_user_id=owner_user_id,
            display_name=display_name or "AI 托管",
            execution_prompt="",
            instruction=instruction,
            model=model,
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
        local_project_id: int = 0,
        workspace_binding_override: dict[str, Any] | None = None,
    ) -> "WeworkExecutionProfile":
        metadata = dict(runtime_profile.metadata_json or {}) if runtime_profile else {}
        model = str(model_override or metadata.get("model") or "")
        if not model:
            raise ValueError("Execution model is required")
        return cls(
            owner_user_id=owner_user_id,
            display_name=display_name or "AI",
            execution_prompt=execution_prompt,
            instruction="",
            model=model,
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
        from app.services.workflow_stage_context import (
            workflow_stage_task_instruction,
        )

        return build_project_robot_user_input(
            project_id=project_id,
            task_id=task_id,
            execution_id=execution_id,
            execution_prompt=self.execution_prompt,
            stage_instruction=(
                workflow_stage_task_instruction(workflow_stage_input)
                if workflow_stage_input
                else ""
            ),
        )

    def build_runtime_payload(
        self,
        db: Session,
        *,
        execution_id: int,
        runtime_task_id: str,
        task: Any,
        cloud_project_id: str,
        origin_context: dict[str, Any],
        execution_device_id: str = "",
        materialize_execution_request: bool = True,
    ) -> dict[str, Any]:
        """Build a transient runtime request from canonical live configuration.

        A cloud dispatcher materializes the complete request immediately before
        transport. Local execution leaves model resolution to the App's current
        model catalog. Neither form is persisted.
        """

        owner = db.get(User, self.owner_user_id)
        project = db.get(CloudProject, cloud_project_id)
        if owner is None or project is None:
            raise ValueError("Wework execution owner or project is unavailable")
        model_config: dict[str, Any] = {}
        if self.model and materialize_execution_request:
            from app.services.chat.trigger.unified import (
                build_wework_runtime_model_config,
            )

            model_config = build_wework_runtime_model_config(
                db,
                model_name=self.model,
                creator=owner,
            )
        runtime_model_id = self.model
        if materialize_execution_request and model_config.get("base_url"):
            runtime_model_id = (
                model_config.get("codex_catalog_model_id") or "wework-gpt-5.6-sol"
            )

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
                environment=("cloud" if materialize_execution_request else "local"),
                execution_device_id=execution_device_id,
                local_project_id=self.local_project_id,
            )
        if workspace_binding.status != "ready":
            raise WeworkExecutionProfileError(
                "Robot workspace binding is ambiguous; select an exact workspace"
            )
        has_bound_workspace = workspace_binding.type != "standalone"
        workflow_stage_input = origin_context.get("workflow_stage_input")
        workspace_policy = ""
        workspace_source_task: dict[str, str] | None = None
        if isinstance(workflow_stage_input, dict):
            target_stage = workflow_stage_input.get("target_stage")
            if isinstance(target_stage, dict):
                workspace_policy = str(
                    target_stage.get("workspace_policy") or "composer"
                )
            if workspace_policy == "inherit":
                dependencies = workflow_stage_input.get("dependencies")
                for dependency in reversed(
                    dependencies if isinstance(dependencies, list) else []
                ):
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
                        if (
                            device_id
                            and source_task_id
                            and (
                                not execution_device_id
                                or device_id == execution_device_id
                            )
                        ):
                            workspace_source_task = {
                                "deviceId": device_id,
                                "taskId": source_task_id,
                            }
                            break
                    if workspace_source_task:
                        break
                if workspace_source_task is None:
                    raise WeworkExecutionProfileError(
                        "Inherited workflow workspace is unavailable on the "
                        "selected execution device"
                    )
        has_stage_workspace = workspace_policy == "inherit" or (
            workspace_policy == "composer" and has_bound_workspace
        )
        prompt = self.user_input(
            project_id=str(project.id),
            task_id=task_id,
            execution_id=execution_id,
            workflow_stage_input=(
                workflow_stage_input if isinstance(workflow_stage_input, dict) else None
            ),
        )
        title = str(getattr(task, "title", "") or "")
        bot_id: int | str = self.agent_id or 0
        origin = {
            "type": "project_automation" if self.manager_mode else "board_task",
            "cloudProjectId": str(project.id),
            "loopItemId": str(getattr(task, "id", "")),
            **origin_context,
        }
        origin["workspacePolicy"] = workspace_policy or self.workspace_policy
        if self.manager_mode:
            origin["automationRole"] = "manager"
        bot = [
            {
                "id": bot_id,
                "name": self.display_name,
                "shell_type": "Codex",
            }
        ]
        additional_context: dict[str, dict[str, str]] = {}
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

        request = RuntimeTaskCreateRequest(
            schemaVersion=2,
            taskId=runtime_task_id,
            runtime="codex",
            message=prompt,
            title=title,
            modelId=runtime_model_id or None,
            modelConfig=model_config or None,
            bot=bot,
            cloudProjectId=str(project.id),
            projectId=(
                workspace_binding.project_id
                if workspace_binding.type == "backend_project"
                else None
            ),
            deviceWorkspaceId=workspace_binding.device_workspace_id,
            deviceId=execution_device_id or None,
            runtimeProjectKey=(
                workspace_binding.runtime_project_key
                if workspace_binding.type == "device_project"
                else None
            ),
            origin=origin,
            standaloneChatWorkspace=(
                not has_stage_workspace and workspace_binding.type == "standalone"
            ),
            workspaceSourceTask=workspace_source_task,
            additionalContext=additional_context,
            projectPlugins=list(self.plugins),
            execution=(
                {"workspace": {"source": "git_worktree"}}
                if (has_bound_workspace or workspace_source_task)
                and self.workspace_policy == "git_worktree"
                else None
            ),
        )
        if materialize_execution_request:
            from app.services.runtime_work_service import (
                compile_runtime_task_create,
            )

            return compile_runtime_task_create(
                db=db,
                user_id=owner.id,
                request=request,
            ).payload

        payload = request.model_dump(by_alias=True, exclude_none=True)
        if workspace_binding.project_id is not None:
            # V1 Wework local dispatchers read this exact Backend Project ID.
            # The V2 request itself uses projectId and never forwards this
            # compatibility alias to Executor.
            payload["local_project_id"] = workspace_binding.project_id
        return payload
