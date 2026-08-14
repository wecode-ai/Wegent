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
    system_prompt: str
    instruction: str
    model: str = ""
    agent_id: str = ""
    local_project_id: int = 0
    manager_mode: bool = False

    @classmethod
    def for_project_robot(
        cls,
        agent: ProjectChatAgent,
        *,
        instruction: str | None = None,
    ) -> "WeworkExecutionProfile":
        from app.services.project_chat.service import bot_config

        config = bot_config(agent)
        return cls(
            owner_user_id=int(agent.created_by_user_id or 0),
            display_name=str(agent.title or agent.name or "AI"),
            system_prompt=str(config.get("system_prompt") or ""),
            instruction=instruction or "",
            model=str(config.get("model") or ""),
            agent_id=agent.id,
            local_project_id=int(agent.local_project_id or 0),
        )

    @classmethod
    def for_automation_manager(
        cls,
        *,
        owner_user_id: int,
        display_name: str,
        instruction: str,
        model: str,
        system_prompt: str = "",
        local_project_id: int = 0,
    ) -> "WeworkExecutionProfile":
        if not model:
            raise ValueError("Custom AI manager model is required")
        return cls(
            owner_user_id=owner_user_id,
            display_name=display_name or "AI 托管",
            system_prompt=system_prompt,
            instruction=instruction,
            model=model,
            local_project_id=local_project_id,
            manager_mode=True,
        )

    def identity_prompt(self) -> str:
        if self.manager_mode:
            base = (
                f"你是 {self.display_name}，负责读取看板信息并通过工具将任务分配给"
                "合适的项目成员或项目机器人。你不是任务执行者。"
            )
        else:
            base = f"你是 {self.display_name}，这个项目任务的 AI 执行者。"
        if self.system_prompt:
            base = f"{base}\n{self.system_prompt}"
        return base

    def runtime_prompt(self) -> str:
        identity = self.identity_prompt()
        return (
            f"{identity}\n\n自动化规则指令：\n{self.instruction}"
            if self.instruction
            else identity
        )

    def build_runtime_payload(
        self,
        db: Session,
        *,
        runtime_task_id: str,
        task: Any,
        cloud_project_id: str,
        origin_context: dict[str, Any],
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

        prompt = self.runtime_prompt()
        identity = self.identity_prompt()
        title = str(getattr(task, "title", "") or "")
        task_context = task.to_context() if hasattr(task, "to_context") else dict(task)
        project_context = {
            "id": str(project.id),
            "key": project.project_key,
            "name": project.title or project.name or "",
            "description": project.description or "",
            "task_provider": project.task_provider,
        }
        event_context = origin_context.get("event")
        event_context = event_context if isinstance(event_context, dict) else {}
        team_id = int(getattr(team, "id", 0) or 0)
        team_name = str(getattr(team, "name", "") or "")
        team_namespace = str(getattr(team, "namespace", "default") or "default")
        subtask_id = f"{runtime_task_id}-assistant"
        bot_id: int | str = self.agent_id or 0
        origin = {
            "type": "project_automation" if origin_context else "board_task",
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
                "system_prompt": identity,
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
            "system_prompt": identity,
            "prompt": prompt,
            "model_config": model_config,
            "standalone_chat_workspace": self.local_project_id <= 0,
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
        context_value = lambda value: {
            "kind": "application",
            "value": json.dumps(value, ensure_ascii=False, default=str),
        }
        additional_context = {
            "projectChatAgent": {
                "kind": "application",
                "value": identity,
            },
        }
        if not self.manager_mode:
            additional_context.update(
                {
                    "project": context_value(project_context),
                    "task": context_value(task_context),
                    "event": context_value(event_context),
                    "projectChat": {
                        "kind": "application",
                        "value": (
                            f"This run is bound to task cloud://projects/{project.id}/todos/"
                            f"{getattr(task, 'id', '')}. The project, current task context, "
                            "and trigger event are provided in separate application contexts. "
                            "Use that context to perform the requested work. Your final response "
                            "is a reviewable task comment."
                        ),
                    },
                }
            )

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
            "standaloneChatWorkspace": self.local_project_id <= 0,
            "additionalContext": additional_context,
        }
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
