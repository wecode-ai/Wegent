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

from app.models.delivery import CloudProject, ProjectChatAgent
from app.models.user import User


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

    @classmethod
    def for_project_robot(
        cls,
        agent: ProjectChatAgent,
    ) -> "WeworkExecutionProfile":
        from app.services.project_chat.service import (
            bot_config,
            bot_max_concurrent_executions,
        )

        config = bot_config(agent)
        return cls(
            owner_user_id=int(agent.created_by_user_id or 0),
            display_name=str(agent.title or agent.name or "AI"),
            execution_prompt=str(config.get("execution_prompt") or ""),
            instruction="",
            model=str(config.get("model") or ""),
            agent_id=agent.id,
            local_project_id=int(agent.local_project_id or 0),
            max_concurrent_executions=bot_max_concurrent_executions(agent),
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
        team = _resolve_default_wework_team(db, owner.id)
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
            elif workspace_policy == "composer" and self.local_project_id <= 0:
                raise WeworkExecutionProfileError(
                    "Workflow stage requires a configured robot code project"
                )
        has_stage_workspace = workspace_policy in {"composer", "inherit"}
        prompt = self.user_input(
            project_id=str(project.id),
            task_id=task_id,
            execution_id=execution_id,
            workflow_stage_input=(
                workflow_stage_input if isinstance(workflow_stage_input, dict) else None
            ),
        )
        title = str(getattr(task, "title", "") or "")
        team_id = int(getattr(team, "id", 0) or 0)
        team_name = str(getattr(team, "name", "") or "")
        team_namespace = str(getattr(team, "namespace", "default") or "default")
        subtask_id = f"{runtime_task_id}-assistant"
        bot_id: int | str = self.agent_id or 0
        origin = {
            "type": "project_automation" if self.manager_mode else "board_task",
            "cloudProjectId": str(project.id),
            "loopItemId": str(getattr(task, "id", "")),
            **origin_context,
        }
        if self.manager_mode:
            origin["automationRole"] = "manager"
        bot = [
            {
                "id": bot_id,
                "name": self.display_name,
                "shell_type": "Codex",
            }
        ]
        execution_request = {
            "task_id": runtime_task_id,
            "subtask_id": subtask_id,
            "team_id": team_id,
            "team_name": team_name,
            "team_namespace": team_namespace,
            "task_title": title,
            "subtask_title": f"{title} - Assistant",
            "user_id": owner.id,
            "user_name": owner.user_name,
            "user": {
                "id": owner.id,
                "name": owner.user_name,
                "user_name": owner.user_name,
                "email": owner.email,
            },
            "bot": bot,
            "bot_name": self.display_name,
            "bot_namespace": "wework",
            "prompt": prompt,
            "model_config": model_config,
            "standalone_chat_workspace": not has_stage_workspace
            and self.local_project_id <= 0,
            "enable_tools": True,
            "enable_web_search": False,
            "enable_deep_thinking": False,
            "skill_names": [],
            "preload_skills": [],
            "user_selected_skills": [],
            "mcp_servers": [],
            "new_session": True,
            "ephemeral": False,
            "is_group_chat": False,
            "collaboration_model": "single",
            "mode": "code",
            "task_mode": "code",
            "attachments": [],
            "runtime_permission_profile": ":danger-full-access",
            # The executor uses this explicit domain origin to decide which
            # runtime capabilities belong to the request. Only automation
            # managers receive assignment tools; project robots receive board
            # context without manager authority.
            "origin": origin,
        }
        if (
            self.local_project_id > 0 or workspace_source_task
        ) and self.max_concurrent_executions > 1:
            execution_request["workspace_source"] = "git_worktree"
        if workspace_source_task:
            execution_request["workspace_source_task"] = workspace_source_task
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

        payload = {
            "taskId": runtime_task_id,
            "teamId": team_id,
            "runtime": "codex",
            "message": prompt,
            "title": title,
            **({"modelId": runtime_model_id} if runtime_model_id else {}),
            "bot": bot,
            "cloudProjectId": str(project.id),
            **(
                {"local_project_id": self.local_project_id}
                if self.local_project_id > 0
                else {}
            ),
            "origin": origin,
            "standaloneChatWorkspace": not has_stage_workspace
            and self.local_project_id <= 0,
            "additionalContext": additional_context,
        }
        if workspace_source_task:
            payload["workspaceSourceTask"] = workspace_source_task
        if (
            self.local_project_id > 0 or workspace_source_task
        ) and self.max_concurrent_executions > 1:
            payload["execution"] = {"workspace": {"source": "git_worktree"}}
        if materialize_execution_request:
            payload["executionRequest"] = execution_request
        return payload


def _resolve_default_wework_team(db: Session, user_id: int) -> Any | None:
    from app.api.endpoints.users import parse_default_team_config
    from app.core.config import settings
    from app.models.kind import Kind

    config = parse_default_team_config(settings.DEFAULT_TEAM_WEWORK)
    if config is None:
        return None
    return (
        db.query(Kind)
        .filter(
            Kind.kind == "Team",
            Kind.name == config.name,
            Kind.namespace == config.namespace,
            Kind.user_id.in_([user_id, 0]),
            Kind.is_active == True,
        )
        .order_by((Kind.user_id == user_id).desc())
        .first()
    )
