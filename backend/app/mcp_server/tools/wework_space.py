# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Authenticated project-space tools for AI-managed automation runs."""

from typing import Any

from sqlalchemy.orm import Session

from app.db.session import SessionLocal
from app.mcp_server.auth import MCPAuthInfo
from app.mcp_server.tools.decorator import mcp_tool
from app.models.delivery import CloudProject, LoopItem
from app.schemas.base_role import BaseRole
from app.schemas.project_chat import LoopItemAssign
from app.services.cloud_projects.access import require_cloud_project_role
from app.services.cloud_projects.service import cloud_project_service
from app.services.loop_items.external_provider import external_loop_item_provider
from app.services.loop_items.service import loop_item_service
from app.services.project_chat.service import project_chat_service


def _project(db: Session, project_id: str, user_id: int) -> CloudProject:
    require_cloud_project_role(db, project_id, user_id, BaseRole.Reporter)
    project = db.get(CloudProject, project_id)
    if project is None:
        raise ValueError("Project not found")
    return project


def _item_view(item: LoopItem) -> dict[str, Any]:
    return {
        "id": item.id,
        "project_id": str(item.cloud_project_id),
        "title": item.title or "",
        "description": item.description or "",
        "status": item.status,
        "priority": item.priority,
        "tags": item.tags,
        "assignee_user_id": item.assignee_user_id or None,
        "assignee_agent_id": item.assignee_agent_id or None,
        "version": item.version,
    }


def _provider_item_view(values: dict[str, object]) -> dict[str, Any]:
    """Normalize an external provider response to the MCP task contract."""

    return {
        "id": str(values.get("id") or ""),
        "project_id": str(values.get("cloud_project_id") or ""),
        "title": str(values.get("title") or ""),
        "description": str(values.get("description") or ""),
        "status": str(values.get("status") or ""),
        "priority": str(values.get("priority") or ""),
        "tags": list(values.get("tags") or []),
        "assignee_user_id": values.get("assignee_user_id"),
        "assignee_agent_id": values.get("assignee_agent_id"),
        "version": int(values.get("version") or 0),
    }


def _task_view(values: LoopItem | dict[str, object]) -> dict[str, Any]:
    if isinstance(values, LoopItem):
        return _item_view(values)
    return _provider_item_view(values)


@mcp_tool(server="wework_space")
def get_project(token_info: MCPAuthInfo, project_id: str) -> dict[str, Any]:
    """Read one project space and its assignable members and robots."""

    with SessionLocal() as db:
        project = _project(db, project_id, token_info.user_id)
        agents = project_chat_service.list_agents(
            db,
            user_id=token_info.user_id,
            project_id=str(project.id),
        )
        members = cloud_project_service.list_members(
            db,
            int(str(project.id)),
            token_info.user_id,
        )
        return {
            "id": project.id,
            "name": project.title or "",
            "description": project.description or "",
            "tags": project.tags,
            "members": [
                {
                    "id": member["user_id"],
                    "name": member["user_name"],
                    "role": member["role"],
                }
                for member in members
            ],
            "robots": [
                {
                    "id": agent.id,
                    "name": agent.name or "AI",
                    "description": agent.description or "",
                }
                for agent in agents
            ],
        }


@mcp_tool(server="wework_space")
def list_tasks(
    token_info: MCPAuthInfo,
    project_id: str,
    status: str = "",
) -> list[dict[str, Any]]:
    """List tasks in a project space, optionally filtered by status."""

    with SessionLocal() as db:
        project = _project(db, project_id, token_info.user_id)
        if project.task_provider in {"github", "gitlab"}:
            values = external_loop_item_provider.list(
                db, int(str(project.id)), token_info.user_id
            )
            if status:
                values = [item for item in values if item.get("status") == status]
            return [_provider_item_view(item) for item in values]

        items = loop_item_service.list(db, int(str(project.id)), token_info.user_id)
        if status:
            items = [item for item in items if item.status == status]
        return [_item_view(item) for item in items]


@mcp_tool(server="wework_space")
def get_task(token_info: MCPAuthInfo, project_id: str, task_id: str) -> dict[str, Any]:
    """Read the full details and current assignment of one project task."""

    with SessionLocal() as db:
        project = _project(db, project_id, token_info.user_id)
        if project.task_provider in {"github", "gitlab"}:
            values = external_loop_item_provider.get(db, task_id, token_info.user_id)
            if str(values.get("cloud_project_id")) != str(project.id):
                raise ValueError("Task not found")
            return _provider_item_view(values)

        item = loop_item_service.get(db, task_id, token_info.user_id)
        if str(item.cloud_project_id) != str(project.id):
            raise ValueError("Task not found")
        return _item_view(item)


@mcp_tool(server="wework_space")
def assign_task(
    token_info: MCPAuthInfo,
    project_id: str,
    task_id: str,
    assignee_type: str,
    assignee_id: str,
) -> dict[str, Any]:
    """Assign a task to a project member or project robot."""

    if assignee_type not in {"user", "agent"}:
        raise ValueError("assignee_type must be user or agent")
    with SessionLocal() as db:
        project = _project(db, project_id, token_info.user_id)
        require_cloud_project_role(
            db, project.id, token_info.user_id, BaseRole.Maintainer
        )
        values: LoopItem | dict[str, object]
        if project.task_provider in {"github", "gitlab"}:
            current = external_loop_item_provider.get(db, task_id, token_info.user_id)
            if str(current.get("cloud_project_id")) != str(project.id):
                raise ValueError("Task not found")
            values = external_loop_item_provider.assign(
                db,
                task_id,
                token_info.user_id,
                LoopItemAssign(
                    version=int(current.get("version") or 0),
                    assignee_type=assignee_type,
                    assignee_id=assignee_id,
                ),
            )
        else:
            item = loop_item_service.get(db, task_id, token_info.user_id)
            if str(item.cloud_project_id) != str(project.id):
                raise ValueError("Task not found")
            values = loop_item_service.assign(
                db,
                project_id=int(str(project.id)),
                item_id=item.id,
                user_id=token_info.user_id,
                values=LoopItemAssign(
                    version=item.version,
                    assignee_type=assignee_type,
                    assignee_id=assignee_id,
                ),
            )
        return _task_view(values)
