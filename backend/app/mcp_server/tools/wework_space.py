# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Authenticated Backend project-space tools for Wegent board tasks.

Board-originated Wegent Tasks use this remote server from both ChatShell and
Executor. Ordinary Wework Tasks keep using Executor's native stdio server.
"""

from __future__ import annotations

import base64
import logging
from io import BytesIO
from typing import Any

from sqlalchemy.orm import Session

from app.core.config import settings
from app.db.session import SessionLocal
from app.mcp_server.auth import MCPAuthInfo
from app.mcp_server.tools.decorator import mcp_tool
from app.models.delivery import CloudProject, Delivery, LoopItem
from app.models.user import User
from app.schemas.base_role import BaseRole
from app.schemas.cloud_file import CloudFileResponse
from app.schemas.cloud_project import CloudProjectCreate, CloudProjectUpdate
from app.schemas.delivery import (
    DeliveryDetailResponse,
    DeliveryResponse,
    LoopItemAttachmentResponse,
    LoopItemCreate,
    LoopItemReorder,
    LoopItemResponse,
    LoopItemUpdate,
)
from app.schemas.project_chat import LoopItemAssign
from app.services.cloud_files import cloud_file_service
from app.services.cloud_projects.access import require_cloud_project_role
from app.services.cloud_projects.service import cloud_project_service
from app.services.delivery import delivery_service
from app.services.loop_items.external_provider import external_loop_item_provider
from app.services.loop_items.provider_router import (
    loop_item_attachment_provider_router,
    loop_item_provider_router,
)
from app.services.loop_items.service import loop_item_service
from app.services.project_automation_execution import project_automation_execution
from app.services.project_chat.service import project_chat_service
from app.stores.tasks import task_store

BOARD_TASK_SOURCES = {
    "project_automation",
    "board_team_assignment",
    "board_team_continuation",
}
MAX_INLINE_CONTENT_BYTES = 1024 * 1024
logger = logging.getLogger(__name__)


def _user(db: Session, user_id: int) -> User:
    user = db.get(User, user_id)
    if user is None:
        raise ValueError("Authenticated user no longer exists")
    return user


def _task_labels(db: Session, token_info: MCPAuthInfo) -> dict[str, Any]:
    if token_info.auth_type != "task" or token_info.task_id is None:
        return {}
    task = task_store.get_by_id(db, task_id=token_info.task_id)
    task_json = task.json if task and isinstance(task.json, dict) else {}
    metadata = task_json.get("metadata")
    labels = metadata.get("labels") if isinstance(metadata, dict) else None
    return dict(labels) if isinstance(labels, dict) else {}


def _board_context(db: Session, token_info: MCPAuthInfo) -> dict[str, str]:
    labels = _task_labels(db, token_info)
    source = str(labels.get("source") or "")
    project_id = str(labels.get("weworkSpaceProjectId") or "")
    item_id = str(labels.get("weworkSpaceTaskId") or "")
    if source not in BOARD_TASK_SOURCES or not project_id or not item_id:
        return {}
    return {
        "source": source,
        "space_id": project_id,
        "item_id": item_id,
        "project_automation_run_id": str(labels.get("projectAutomationRunId") or ""),
        "board_team_execution_id": str(labels.get("boardTeamExecutionId") or ""),
    }


def _space_id(db: Session, token_info: MCPAuthInfo, requested: str = "") -> str:
    scoped = _board_context(db, token_info).get("space_id", "")
    if scoped and requested and requested != scoped:
        raise ValueError("Space does not match the authenticated board task")
    resolved = requested or scoped
    if not resolved:
        raise ValueError("space_id is required")
    return resolved


def _item_id(db: Session, token_info: MCPAuthInfo, requested: str = "") -> str:
    resolved = requested or _board_context(db, token_info).get("item_id", "")
    if not resolved:
        raise ValueError("item_id is required")
    return resolved


def _project(db: Session, project_id: str, user_id: int) -> CloudProject:
    require_cloud_project_role(db, int(project_id), user_id, BaseRole.Reporter)
    project = db.get(CloudProject, int(project_id))
    if project is None:
        raise ValueError("Project not found")
    return project


def _project_view(project: CloudProject) -> dict[str, Any]:
    metadata = project.metadata_json if isinstance(project.metadata_json, dict) else {}
    return {
        "id": str(project.id),
        "project_key": project.project_key,
        "name": project.title or project.name or "",
        "description": project.description or "",
        "task_provider": metadata.get("task_provider", "local"),
        "tags": metadata.get("tags", []),
        "version": project.version,
    }


def _item_view(db: Session, item: LoopItem, user_id: int) -> dict[str, Any]:
    values = loop_item_service.response_values(db, item, user_id)
    return LoopItemResponse.model_validate(values).model_dump(mode="json")


def _read_item(
    db: Session, project: CloudProject, item_id: str, user_id: int
) -> dict[str, Any]:
    if project.task_provider in {"github", "gitlab"}:
        values = external_loop_item_provider.get(db, item_id, user_id)
        if str(values.get("cloud_project_id")) != str(project.id):
            raise ValueError("Board item not found in this space")
        return LoopItemResponse.model_validate(values).model_dump(mode="json")
    item = loop_item_service.get(db, item_id, user_id)
    if str(item.cloud_project_id) != str(project.id):
        raise ValueError("Board item not found in this space")
    return _item_view(db, item, user_id)


def _list_items(
    db: Session, project: CloudProject, user_id: int
) -> list[dict[str, Any]]:
    if project.task_provider in {"github", "gitlab"}:
        values = external_loop_item_provider.list(db, project.id, user_id)
        return [
            LoopItemResponse.model_validate(value).model_dump(mode="json")
            for value in values
        ]
    return [
        _item_view(db, item, user_id)
        for item in loop_item_service.list(db, project.id, user_id)
    ]


def _attachment_ids(db: Session, item_id: str, user_id: int) -> set[str]:
    values = loop_item_attachment_provider_router.list(db, item_id, user_id)
    result: set[str] = set()
    for value in values:
        if isinstance(value, dict):
            result.add(str(value.get("id") or ""))
        else:
            result.add(str(getattr(value, "id", "")))
    return result


def _decode_upload(content_text: str, content_base64: str) -> bytes:
    if content_base64:
        try:
            return base64.b64decode(content_base64, validate=True)
        except ValueError as exc:
            raise ValueError("content_base64 is invalid") from exc
    if content_text:
        return content_text.encode()
    raise ValueError("content_text or content_base64 is required")


def _content_view(content: bytes, content_type: str, filename: str) -> dict[str, Any]:
    if len(content) > MAX_INLINE_CONTENT_BYTES:
        raise ValueError("Content exceeds the 1 MiB MCP inline read limit")
    result: dict[str, Any] = {
        "filename": filename,
        "content_type": content_type,
        "size_bytes": len(content),
        "content_base64": base64.b64encode(content).decode(),
    }
    if content_type.startswith("text/") or content_type in {
        "application/json",
        "application/xml",
    }:
        result["content_text"] = content.decode(errors="replace")
    return result


def _delivery_view(db: Session, delivery: Delivery) -> dict[str, Any]:
    return DeliveryResponse.model_validate(
        {**delivery.__dict__, "assets": delivery_service.list_assets(db, delivery.id)}
    ).model_dump(mode="json")


@mcp_tool(server="wework_space")
def get_current_context(token_info: MCPAuthInfo) -> dict[str, Any]:
    """Resolve the authenticated board Task to its current space and board item."""

    with SessionLocal() as db:
        context = _board_context(db, token_info)
        if not context:
            raise ValueError("Authenticated Task is not a Wegent board execution")
        project = _project(db, context["space_id"], token_info.user_id)
        return {
            **context,
            "space": _project_view(project),
            "item": _read_item(db, project, context["item_id"], token_info.user_id),
        }


@mcp_tool(server="wework_space")
def list_spaces(token_info: MCPAuthInfo) -> list[dict[str, Any]]:
    """List Backend project spaces available to the authenticated user or Task."""

    with SessionLocal() as db:
        context = _board_context(db, token_info)
        projects = cloud_project_service.list_accessible(db, token_info.user_id)
        if context:
            projects = [
                value for value in projects if str(value.id) == context["space_id"]
            ]
        return [_project_view(project) for project in projects]


@mcp_tool(server="wework_space")
def create_space(
    token_info: MCPAuthInfo,
    name: str,
    project_key: str = "",
    description: str = "",
) -> dict[str, Any]:
    """Create a Backend project space; user authentication is required."""

    if token_info.auth_type == "task":
        raise ValueError("Board Tasks cannot create project spaces")
    with SessionLocal() as db:
        created = cloud_project_service.create(
            db,
            token_info.user_id,
            CloudProjectCreate(
                name=name,
                project_key=project_key or None,
                description=description,
            ),
        )
        return _project_view(created)


@mcp_tool(server="wework_space")
def update_space(
    token_info: MCPAuthInfo,
    project: dict[str, Any],
    space_id: str = "",
) -> dict[str, Any]:
    """Update the current Backend project space."""

    with SessionLocal() as db:
        resolved = _space_id(db, token_info, space_id)
        updated = cloud_project_service.update(
            db,
            int(resolved),
            token_info.user_id,
            CloudProjectUpdate.model_validate(project),
        )
        return _project_view(updated)


@mcp_tool(server="wework_space")
def list_board_items(
    token_info: MCPAuthInfo, space_id: str = ""
) -> list[dict[str, Any]]:
    """List board items in the current Backend project space."""

    with SessionLocal() as db:
        project = _project(db, _space_id(db, token_info, space_id), token_info.user_id)
        return _list_items(db, project, token_info.user_id)


@mcp_tool(server="wework_space")
def search_board_items(
    token_info: MCPAuthInfo,
    query: str = "",
    space_id: str = "",
    status: str = "",
    priority: str = "",
    tag: str = "",
    creator_user_id: int = 0,
    parent_id: str = "",
    has_children: bool | None = None,
    limit: int = 50,
) -> list[dict[str, Any]]:
    """Search board items using text and structured filters."""

    with SessionLocal() as db:
        project = _project(db, _space_id(db, token_info, space_id), token_info.user_id)
        items = _list_items(db, project, token_info.user_id)
        parent_ids = {str(item.get("parent_id") or "") for item in items}
        needle = query.casefold().strip()

        def matches(item: dict[str, Any]) -> bool:
            text = " ".join(
                [
                    str(item.get("id") or ""),
                    str(item.get("title") or ""),
                    str(item.get("description") or ""),
                    " ".join(item.get("tags") or []),
                ]
            ).casefold()
            return (
                (not needle or needle in text)
                and (not status or item.get("status") == status)
                and (not priority or item.get("priority") == priority)
                and (not tag or tag in (item.get("tags") or []))
                and (
                    not creator_user_id
                    or item.get("created_by_user_id") == creator_user_id
                )
                and (not parent_id or item.get("parent_id") == parent_id)
                and (
                    has_children is None
                    or ((str(item.get("id")) in parent_ids) == has_children)
                )
            )

        return [item for item in items if matches(item)][: max(1, min(limit, 200))]


@mcp_tool(server="wework_space")
async def create_board_item(
    token_info: MCPAuthInfo, item: dict[str, Any], space_id: str = ""
) -> dict[str, Any]:
    """Create a board item and activate an assigned Wegent robot if present."""

    with SessionLocal() as db:
        project = _project(db, _space_id(db, token_info, space_id), token_info.user_id)
        user = _user(db, token_info.user_id)
        created = loop_item_provider_router.create(
            db, project, user, LoopItemCreate.model_validate(item)
        )
        from app.services.project_automations import (
            ProjectAutomationEvent,
            project_automation_processor,
        )

        response = LoopItemResponse.model_validate(created.values)
        try:
            await project_automation_processor.process(
                db,
                ProjectAutomationEvent(
                    event_type="task.created",
                    project_id=str(project.id),
                    subject_id=str(created.values["id"]),
                    source=project.task_provider,
                    actor_user_id=user.id,
                    payload=response.model_dump(mode="json"),
                ),
            )
        except Exception:
            db.rollback()
            logger.exception(
                "Board MCP automation processing failed project=%s item=%s",
                project.id,
                created.values.get("id"),
            )
        internal = created.internal_item or db.get(LoopItem, str(created.values["id"]))
        if internal is not None and internal.assignee_agent_id:
            from app.services.board_team_execution import dispatch_board_team_assignment

            await dispatch_board_team_assignment(db, item=internal, user=user)
        return _read_item(db, project, str(created.values["id"]), token_info.user_id)


@mcp_tool(server="wework_space")
def get_board_item(
    token_info: MCPAuthInfo, space_id: str = "", item_id: str = ""
) -> dict[str, Any]:
    """Read one board item, defaulting to the authenticated Task's item."""

    with SessionLocal() as db:
        project = _project(db, _space_id(db, token_info, space_id), token_info.user_id)
        return _read_item(
            db, project, _item_id(db, token_info, item_id), token_info.user_id
        )


@mcp_tool(server="wework_space")
def get_assignment_candidates(
    token_info: MCPAuthInfo, space_id: str = ""
) -> dict[str, Any]:
    """List assignable project members and user-created board robots."""

    with SessionLocal() as db:
        project = _project(db, _space_id(db, token_info, space_id), token_info.user_id)
        members = cloud_project_service.list_members(db, project.id, token_info.user_id)
        robots = project_chat_service.list_agents(
            db, user_id=token_info.user_id, project_id=str(project.id)
        )
        return {
            "members": [
                {
                    "id": value["user_id"],
                    "name": value["user_name"],
                    "role": value["role"],
                    "capability": value.get("capability_description") or "",
                }
                for value in members
            ],
            "robots": [
                {
                    "id": robot.id,
                    "name": robot.name or "AI",
                    "runtime": robot.runtime,
                    "capability": robot.capability_description or "",
                }
                for robot in robots
            ],
        }


@mcp_tool(server="wework_space")
async def assign_board_item(
    token_info: MCPAuthInfo,
    assignee_type: str,
    assignee_id: str,
    space_id: str = "",
    item_id: str = "",
) -> dict[str, Any]:
    """Assign a board item to a project member or user-created board robot."""

    with SessionLocal() as db:
        project = _project(db, _space_id(db, token_info, space_id), token_info.user_id)
        resolved_item_id = _item_id(db, token_info, item_id)
        current = _read_item(db, project, resolved_item_id, token_info.user_id)
        values = LoopItemAssign(
            version=int(current["version"]),
            assignee_type=assignee_type,
            assignee_id=assignee_id,
        )
        context = _board_context(db, token_info)
        if context.get("source") == "project_automation":
            run_id = context.get("project_automation_run_id")
            if not run_id or resolved_item_id != context.get("item_id"):
                raise ValueError("Automation manager may only assign its current item")
            result = project_automation_execution.assign_from_manager(
                db,
                run_id=run_id,
                user_id=token_info.user_id,
                project_id=str(project.id),
                task_id=resolved_item_id,
                assignee_type=assignee_type,
                assignee_id=assignee_id,
            )
            if isinstance(result, LoopItem):
                return _item_view(db, result, token_info.user_id)
            return LoopItemResponse.model_validate(result).model_dump(mode="json")
        if project.task_provider in {"github", "gitlab"}:
            external_loop_item_provider.assign(
                db, resolved_item_id, token_info.user_id, values
            )
            assigned = db.get(LoopItem, resolved_item_id)
        else:
            assigned = loop_item_service.assign(
                db,
                project_id=project.id,
                item_id=resolved_item_id,
                user_id=token_info.user_id,
                values=values,
            )
        if assignee_type == "agent" and assigned is not None:
            from app.services.board_team_execution import dispatch_board_team_assignment

            await dispatch_board_team_assignment(
                db, item=assigned, user=_user(db, token_info.user_id)
            )
        return _read_item(db, project, resolved_item_id, token_info.user_id)


@mcp_tool(server="wework_space")
async def update_board_item(
    token_info: MCPAuthInfo,
    item: dict[str, Any],
    space_id: str = "",
    item_id: str = "",
) -> dict[str, Any]:
    """Update a board item and activate a newly assigned Wegent robot."""

    with SessionLocal() as db:
        project = _project(db, _space_id(db, token_info, space_id), token_info.user_id)
        resolved_item_id = _item_id(db, token_info, item_id)
        _read_item(db, project, resolved_item_id, token_info.user_id)
        values = LoopItemUpdate.model_validate(item)
        if project.task_provider in {"github", "gitlab"}:
            external_loop_item_provider.update(
                db, resolved_item_id, token_info.user_id, values
            )
            updated = db.get(LoopItem, resolved_item_id)
        else:
            updated = loop_item_service.update(
                db, resolved_item_id, token_info.user_id, values
            )
        if values.assignee_agent_id and updated is not None:
            from app.services.board_team_execution import dispatch_board_team_assignment

            await dispatch_board_team_assignment(
                db, item=updated, user=_user(db, token_info.user_id)
            )
        return _read_item(db, project, resolved_item_id, token_info.user_id)


@mcp_tool(server="wework_space")
def add_board_item_comment(
    token_info: MCPAuthInfo,
    body: str,
    space_id: str = "",
    item_id: str = "",
) -> dict[str, Any]:
    """Add a comment to a provider-backed board item."""

    with SessionLocal() as db:
        project = _project(db, _space_id(db, token_info, space_id), token_info.user_id)
        resolved_item_id = _item_id(db, token_info, item_id)
        _read_item(db, project, resolved_item_id, token_info.user_id)
        return dict(
            external_loop_item_provider.add_comment(
                db, resolved_item_id, token_info.user_id, body
            )
        )


@mcp_tool(server="wework_space")
def list_space_files(
    token_info: MCPAuthInfo, space_id: str = "", prefix: str = ""
) -> list[dict[str, Any]]:
    """List files and folders in the current Backend project space."""

    with SessionLocal() as db:
        resolved = _space_id(db, token_info, space_id)
        return [
            CloudFileResponse.model_validate(value).model_dump(mode="json")
            for value in cloud_file_service.list(
                db, int(resolved), token_info.user_id, prefix or None
            )
        ]


@mcp_tool(server="wework_space")
def read_space_file(
    token_info: MCPAuthInfo, file_id: str, space_id: str = ""
) -> dict[str, Any]:
    """Read a Backend project-space file as inline text/base64 content."""

    with SessionLocal() as db:
        resolved = _space_id(db, token_info, space_id)
        file = cloud_file_service.get(db, int(file_id), token_info.user_id)
        if str(file.cloud_project_id) != resolved or not file.object_key:
            raise ValueError("File not found in this space")
        content = cloud_file_service.storage.get_bytes(
            file.object_key, MAX_INLINE_CONTENT_BYTES + 1
        )
        return _content_view(
            content, file.content_type or "application/octet-stream", file.name
        )


@mcp_tool(server="wework_space")
def list_item_attachments(
    token_info: MCPAuthInfo, space_id: str = "", item_id: str = ""
) -> list[dict[str, Any]]:
    """List attachments of a board item."""

    with SessionLocal() as db:
        project = _project(db, _space_id(db, token_info, space_id), token_info.user_id)
        resolved_item_id = _item_id(db, token_info, item_id)
        _read_item(db, project, resolved_item_id, token_info.user_id)
        values = loop_item_attachment_provider_router.list(
            db, resolved_item_id, token_info.user_id
        )
        return [
            LoopItemAttachmentResponse.model_validate(value).model_dump(mode="json")
            for value in values
        ]


@mcp_tool(server="wework_space")
def upload_item_attachment(
    token_info: MCPAuthInfo,
    display_name: str,
    content_text: str = "",
    content_base64: str = "",
    content_type: str = "application/octet-stream",
    space_id: str = "",
    item_id: str = "",
) -> dict[str, Any]:
    """Upload inline text/base64 content as a board-item attachment."""

    content = _decode_upload(content_text, content_base64)
    with SessionLocal() as db:
        project = _project(db, _space_id(db, token_info, space_id), token_info.user_id)
        resolved_item_id = _item_id(db, token_info, item_id)
        _read_item(db, project, resolved_item_id, token_info.user_id)
        attachment = loop_item_attachment_provider_router.add(
            db,
            resolved_item_id,
            token_info.user_id,
            display_name,
            content_type,
            BytesIO(content),
            settings.DELIVERY_MAX_ASSET_SIZE_MB * 1024 * 1024,
        )
        return LoopItemAttachmentResponse.model_validate(attachment).model_dump(
            mode="json"
        )


@mcp_tool(server="wework_space")
def read_item_attachment(
    token_info: MCPAuthInfo,
    attachment_id: str,
    space_id: str = "",
    item_id: str = "",
) -> dict[str, Any]:
    """Read a board-item attachment as inline text/base64 content."""

    with SessionLocal() as db:
        project = _project(db, _space_id(db, token_info, space_id), token_info.user_id)
        resolved_item_id = _item_id(db, token_info, item_id)
        _read_item(db, project, resolved_item_id, token_info.user_id)
        if attachment_id not in _attachment_ids(
            db, resolved_item_id, token_info.user_id
        ):
            raise ValueError("Attachment not found on this board item")
        content, content_type, filename = loop_item_attachment_provider_router.content(
            db, attachment_id, token_info.user_id
        )
        return _content_view(content, content_type, filename)


@mcp_tool(server="wework_space")
def delete_item_attachment(
    token_info: MCPAuthInfo,
    attachment_id: str,
    space_id: str = "",
    item_id: str = "",
) -> dict[str, bool]:
    """Delete a board-item attachment."""

    with SessionLocal() as db:
        project = _project(db, _space_id(db, token_info, space_id), token_info.user_id)
        resolved_item_id = _item_id(db, token_info, item_id)
        _read_item(db, project, resolved_item_id, token_info.user_id)
        if attachment_id not in _attachment_ids(
            db, resolved_item_id, token_info.user_id
        ):
            raise ValueError("Attachment not found on this board item")
        loop_item_attachment_provider_router.delete(
            db, attachment_id, token_info.user_id
        )
        return {"deleted": True}


@mcp_tool(server="wework_space")
def list_deliveries(
    token_info: MCPAuthInfo, space_id: str = "", item_id: str = ""
) -> list[dict[str, Any]]:
    """List immutable deliveries associated with a board item."""

    with SessionLocal() as db:
        project = _project(db, _space_id(db, token_info, space_id), token_info.user_id)
        resolved_item_id = _item_id(db, token_info, item_id)
        _read_item(db, project, resolved_item_id, token_info.user_id)
        external_loop_item_provider.ensure_shadow(
            db, resolved_item_id, token_info.user_id
        )
        return [
            _delivery_view(db, delivery)
            for delivery in delivery_service.list_deliveries(
                db, resolved_item_id, token_info.user_id
            )
        ]


@mcp_tool(server="wework_space")
def read_delivery(
    token_info: MCPAuthInfo, delivery_id: str, space_id: str = ""
) -> dict[str, Any]:
    """Read a delivery and its Markdown/chat handoff content."""

    with SessionLocal() as db:
        project = _project(db, _space_id(db, token_info, space_id), token_info.user_id)
        delivery = delivery_service.get_delivery(db, delivery_id, token_info.user_id)
        item = db.get(LoopItem, delivery.loop_item_id)
        if item is None or str(item.cloud_project_id) != str(project.id):
            raise ValueError("Delivery not found in this space")
        return DeliveryDetailResponse(
            **_delivery_view(db, delivery),
            markdown=delivery_service.read_markdown(delivery),
            chat=delivery_service.read_chat(delivery),
        ).model_dump(mode="json")


@mcp_tool(server="wework_space")
def reorder_board_items(
    token_info: MCPAuthInfo,
    reorder: dict[str, Any],
    space_id: str = "",
) -> list[dict[str, Any]]:
    """Persist the order of board items in one board lane."""

    with SessionLocal() as db:
        project = _project(db, _space_id(db, token_info, space_id), token_info.user_id)
        if project.task_provider in {"github", "gitlab"}:
            return _list_items(db, project, token_info.user_id)
        items = loop_item_service.reorder(
            db,
            project.id,
            token_info.user_id,
            LoopItemReorder.model_validate(reorder),
        )
        return [_item_view(db, item, token_info.user_id) for item in items]
