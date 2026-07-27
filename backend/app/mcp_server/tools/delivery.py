# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""MCP tools for AI access to authorized delivery snapshots."""

from typing import Any
from urllib.parse import urlparse

from app.db.session import SessionLocal
from app.mcp_server.auth import MCPAuthInfo
from app.mcp_server.tools.decorator import mcp_tool
from app.models.delivery import DeliveryAsset, LoopItem, loop_datetime_value_is_unset
from app.schemas.cloud_project import CloudProjectCreate
from app.schemas.delivery import LoopItemCreate, LoopItemUpdate
from app.services.cloud_files import cloud_file_service
from app.services.cloud_projects import cloud_project_service
from app.services.delivery import delivery_service
from app.services.loop_items import loop_item_service

TEXT_ASSET_LIMIT = 1024 * 1024


def _serialize_todo(item: LoopItem) -> dict[str, Any]:
    return {
        "id": item.id,
        "cloudProjectId": item.cloud_project_id,
        "parentId": item.parent_id or None,
        "title": item.title,
        "description": item.description,
        "status": item.status,
        "priority": item.priority,
        "assigneeUserId": item.assignee_user_id or None,
        "dueAt": (None if loop_datetime_value_is_unset(item.due_at) else item.due_at),
        "currentDeliveryId": item.current_delivery_id or None,
        "version": item.version,
        "createdByUserId": item.created_by_user_id,
        "createdAt": item.created_at,
        "updatedAt": item.updated_at,
        "completedAt": (
            None
            if loop_datetime_value_is_unset(item.completed_at)
            else item.completed_at
        ),
        "deletedAt": (
            None if loop_datetime_value_is_unset(item.deleted_at) else item.deleted_at
        ),
    }


def _serialize_collaborator(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": row["id"],
        "loopItemId": row["loop_item_id"],
        "userId": row["user_id"],
        "userName": row["user_name"],
        "email": row["email"] or None,
        "source": row["source"],
        "addedByUserId": row["added_by_user_id"],
        "createdAt": row["created_at"],
    }


@mcp_tool(
    name="list_loop_item_deliveries",
    description="List immutable deliveries available for a TODO or Loop Item.",
    server="delivery",
    exclude_params=["token_info"],
)
def list_loop_item_deliveries(
    loop_item_id: str, token_info: MCPAuthInfo
) -> dict[str, Any]:
    with SessionLocal() as db:
        deliveries = delivery_service.list_deliveries(
            db, loop_item_id, token_info.user_id
        )
        return {
            "deliveries": [
                {
                    "id": delivery.id,
                    "loopItemId": delivery.loop_item_id,
                    "sourceTask": delivery.source_task_snapshot,
                    "deliveredAt": delivery.delivered_at,
                    "assets": [
                        {
                            "id": asset.id,
                            "path": asset.relative_path,
                            "size": asset.size_bytes,
                            "contentType": asset.content_type,
                            "sha256": asset.sha256,
                        }
                        for asset in delivery_service.list_assets(db, delivery.id)
                    ],
                }
                for delivery in deliveries
            ]
        }


@mcp_tool(
    name="read_delivery_markdown",
    description="Read the Markdown handoff instructions from an authorized delivery.",
    server="delivery",
    exclude_params=["token_info"],
)
def read_delivery_markdown(delivery_id: str, token_info: MCPAuthInfo) -> dict[str, Any]:
    with SessionLocal() as db:
        delivery = delivery_service.get_delivery(db, delivery_id, token_info.user_id)
        return {
            "deliveryId": delivery.id,
            "markdown": delivery_service.read_markdown(delivery),
            "chat": delivery_service.read_chat(delivery),
        }


@mcp_tool(
    name="read_delivery_asset",
    description=(
        "Read a small text delivery asset or obtain a short-lived URL for a binary or "
        "large asset. The URL is intended for the running AI task, not end-user sharing."
    ),
    server="delivery",
    exclude_params=["token_info"],
)
def read_delivery_asset(asset_id: str, token_info: MCPAuthInfo) -> dict[str, Any]:
    with SessionLocal() as db:
        asset = db.query(DeliveryAsset).filter(DeliveryAsset.id == asset_id).first()
        if asset is None:
            return {"error": "Delivery asset not found"}
        delivery_service.get_delivery(db, asset.delivery_id, token_info.user_id)
        response: dict[str, Any] = {
            "id": asset.id,
            "path": asset.relative_path,
            "size": asset.size_bytes,
            "contentType": asset.content_type,
            "sha256": asset.sha256,
        }
        is_text = (asset.content_type or "").startswith("text/")
        if is_text and asset.size_bytes <= TEXT_ASSET_LIMIT:
            response["content"] = delivery_service.storage.get_bytes(
                asset.object_key, TEXT_ASSET_LIMIT
            ).decode(errors="replace")
        else:
            response["downloadUrl"] = delivery_service.storage.download_url(
                asset.object_key
            )
            response["expiresInSeconds"] = 900
        return response


@mcp_tool(
    name="list_cloud_projects",
    description="List shared cloud projects the current user can access.",
    server="delivery",
    exclude_params=["token_info"],
)
def list_cloud_projects(token_info: MCPAuthInfo) -> dict[str, Any]:
    with SessionLocal() as db:
        projects = cloud_project_service.list_accessible(db, token_info.user_id)
        return {
            "projects": [
                {
                    "id": project.id,
                    "key": project.project_key,
                    "name": project.name,
                    "description": project.description,
                }
                for project in projects
            ]
        }


@mcp_tool(
    name="create_cloud_project",
    description=(
        "Create a cloud project space for sharing TODOs, deliveries, and files. "
        "project_key (2-16 alphanumeric characters, uppercased automatically) sets "
        "the task numbering prefix, e.g. WEG produces TODO ids like WEG-18; when "
        "omitted a key is generated from the name. The creator automatically "
        "becomes the project Owner."
    ),
    server="delivery",
    exclude_params=["token_info"],
)
def create_cloud_project(
    name: str,
    token_info: MCPAuthInfo,
    project_key: str | None = None,
    description: str = "",
) -> dict[str, Any]:
    with SessionLocal() as db:
        values = CloudProjectCreate(
            name=name, project_key=project_key, description=description
        )
        project = cloud_project_service.create(db, token_info.user_id, values)
        return {
            "id": project.id,
            "key": project.project_key,
            "name": project.name,
            "description": project.description,
        }


@mcp_tool(
    name="list_cloud_workspace",
    description="List authorized shared files and folders in a cloud project.",
    server="delivery",
    exclude_params=["token_info"],
)
def list_cloud_workspace(
    cloud_project_id: int,
    token_info: MCPAuthInfo,
    prefix: str = "",
) -> dict[str, Any]:
    with SessionLocal() as db:
        files = cloud_file_service.list(
            db, cloud_project_id, token_info.user_id, prefix or None
        )
        return {
            "items": [
                {
                    "id": file.id,
                    "path": file.path,
                    "kind": file.kind,
                    "size": file.size_bytes,
                    "contentType": file.content_type,
                    "sha256": file.sha256,
                }
                for file in files
            ]
        }


@mcp_tool(
    name="read_cloud_file",
    description=(
        "Read an authorized small text file from a cloud project, or obtain a "
        "short-lived URL for a binary or large file."
    ),
    server="delivery",
    exclude_params=["token_info"],
)
def read_cloud_file(file_id: int, token_info: MCPAuthInfo) -> dict[str, Any]:
    with SessionLocal() as db:
        file = cloud_file_service.get(db, file_id, token_info.user_id)
        if file.kind != "file" or not file.object_key:
            return {"error": "Cloud path is not a file"}
        response: dict[str, Any] = {
            "id": file.id,
            "path": file.path,
            "size": file.size_bytes,
            "contentType": file.content_type,
            "sha256": file.sha256,
        }
        is_text = (file.content_type or "").startswith("text/")
        if is_text and file.size_bytes <= TEXT_ASSET_LIMIT:
            response["content"] = cloud_file_service.storage.get_bytes(
                file.object_key, TEXT_ASSET_LIMIT
            ).decode(errors="replace")
        else:
            response["downloadUrl"] = cloud_file_service.storage.download_url(
                file.object_key
            )
            response["expiresInSeconds"] = 900
        return response


@mcp_tool(
    name="list_cloud_todos",
    description="List TODOs and their current state in an authorized cloud project.",
    server="delivery",
    exclude_params=["token_info"],
)
def list_cloud_todos(cloud_project_id: int, token_info: MCPAuthInfo) -> dict[str, Any]:
    with SessionLocal() as db:
        items = loop_item_service.list(db, cloud_project_id, token_info.user_id)
        return {
            "items": [
                {
                    "id": item.id,
                    "title": item.title,
                    "status": item.status,
                    "assigneeUserId": item.assignee_user_id,
                    "currentDeliveryId": item.current_delivery_id,
                    "updatedAt": item.updated_at,
                }
                for item in items
            ]
        }


@mcp_tool(
    name="get_cloud_todo",
    description="Get full details of one TODO in an authorized cloud project.",
    server="delivery",
    exclude_params=["token_info"],
)
def get_cloud_todo(item_id: str, token_info: MCPAuthInfo) -> dict[str, Any]:
    with SessionLocal() as db:
        item = loop_item_service.get(db, item_id, token_info.user_id)
        return _serialize_todo(item)


@mcp_tool(
    name="create_cloud_todo",
    description=(
        "Create a TODO in an authorized cloud project. Status must be one of "
        "inbox, pending, in_progress, in_review, completed; priority one of "
        "none, low, medium, high, urgent; due_at is an ISO 8601 datetime."
    ),
    server="delivery",
    exclude_params=["token_info"],
)
def create_cloud_todo(
    cloud_project_id: int,
    title: str,
    token_info: MCPAuthInfo,
    description: str = "",
    status: str = "inbox",
    priority: str = "none",
    assignee_user_id: int | None = None,
    due_at: str | None = None,
    parent_id: str | None = None,
) -> dict[str, Any]:
    with SessionLocal() as db:
        values = LoopItemCreate(
            title=title,
            description=description,
            status=status,
            priority=priority,
            assignee_user_id=assignee_user_id,
            due_at=due_at,
            parent_id=parent_id,
        )
        item = loop_item_service.create(
            db, cloud_project_id, token_info.user_id, values
        )
        return _serialize_todo(item)


@mcp_tool(
    name="update_cloud_todo",
    description=(
        "Update a TODO with optimistic locking: pass the current version from "
        "get_cloud_todo. Only provided fields are changed; fields left out keep "
        "their current values."
    ),
    server="delivery",
    exclude_params=["token_info"],
)
def update_cloud_todo(
    item_id: str,
    version: int,
    token_info: MCPAuthInfo,
    title: str | None = None,
    description: str | None = None,
    status: str | None = None,
    priority: str | None = None,
    assignee_user_id: int | None = None,
    due_at: str | None = None,
    parent_id: str | None = None,
) -> dict[str, Any]:
    with SessionLocal() as db:
        provided = {
            field: value
            for field, value in {
                "title": title,
                "description": description,
                "status": status,
                "priority": priority,
                "assignee_user_id": assignee_user_id,
                "due_at": due_at,
                "parent_id": parent_id,
            }.items()
            if value is not None
        }
        values = LoopItemUpdate(version=version, **provided)
        item = loop_item_service.update(db, item_id, token_info.user_id, values)
        return _serialize_todo(item)


@mcp_tool(
    name="delete_cloud_todo",
    description=(
        "Soft delete a TODO. The TODO moves to the recycle bin and can be "
        "restored with restore_cloud_todo."
    ),
    server="delivery",
    exclude_params=["token_info"],
)
def delete_cloud_todo(item_id: str, token_info: MCPAuthInfo) -> dict[str, Any]:
    with SessionLocal() as db:
        item = loop_item_service.delete(db, item_id, token_info.user_id)
        return _serialize_todo(item)


@mcp_tool(
    name="restore_cloud_todo",
    description="Restore a soft-deleted TODO from the recycle bin.",
    server="delivery",
    exclude_params=["token_info"],
)
def restore_cloud_todo(item_id: str, token_info: MCPAuthInfo) -> dict[str, Any]:
    with SessionLocal() as db:
        item = loop_item_service.restore(db, item_id, token_info.user_id)
        return _serialize_todo(item)


@mcp_tool(
    name="list_cloud_todo_recycle_bin",
    description=(
        "List soft-deleted TODOs of an authorized cloud project, most recently "
        "deleted first."
    ),
    server="delivery",
    exclude_params=["token_info"],
)
def list_cloud_todo_recycle_bin(
    cloud_project_id: int, token_info: MCPAuthInfo
) -> dict[str, Any]:
    with SessionLocal() as db:
        items = loop_item_service.list_deleted(db, cloud_project_id, token_info.user_id)
        return {"items": [_serialize_todo(item) for item in items]}


@mcp_tool(
    name="list_cloud_todo_collaborators",
    description="List collaborators of a TODO in an authorized cloud project.",
    server="delivery",
    exclude_params=["token_info"],
)
def list_cloud_todo_collaborators(
    item_id: str, token_info: MCPAuthInfo
) -> dict[str, Any]:
    with SessionLocal() as db:
        rows = loop_item_service.list_collaborators(db, item_id, token_info.user_id)
        return {"collaborators": [_serialize_collaborator(row) for row in rows]}


@mcp_tool(
    name="add_cloud_todo_collaborator",
    description=(
        "Add a cloud project member as a collaborator of a TODO. Requires "
        "Developer permission on the project."
    ),
    server="delivery",
    exclude_params=["token_info"],
)
def add_cloud_todo_collaborator(
    item_id: str, collaborator_user_id: int, token_info: MCPAuthInfo
) -> dict[str, Any]:
    with SessionLocal() as db:
        row = loop_item_service.add_collaborator(
            db, item_id, collaborator_user_id, token_info.user_id
        )
        return _serialize_collaborator(row)


@mcp_tool(
    name="remove_cloud_todo_collaborator",
    description=(
        "Remove a collaborator from a TODO. Requires Developer permission on "
        "the project."
    ),
    server="delivery",
    exclude_params=["token_info"],
)
def remove_cloud_todo_collaborator(
    item_id: str, collaborator_user_id: int, token_info: MCPAuthInfo
) -> dict[str, Any]:
    with SessionLocal() as db:
        loop_item_service.remove_collaborator(
            db, item_id, collaborator_user_id, token_info.user_id
        )
        return {"removed": True, "loopItemId": item_id, "userId": collaborator_user_id}


@mcp_tool(
    name="list_cloud_todo_attachments",
    description="List attachments of a TODO in an authorized cloud project.",
    server="delivery",
    exclude_params=["token_info"],
)
def list_cloud_todo_attachments(
    item_id: str, token_info: MCPAuthInfo
) -> dict[str, Any]:
    with SessionLocal() as db:
        attachments = loop_item_service.list_attachments(
            db, item_id, token_info.user_id
        )
        return {
            "attachments": [
                {
                    "id": attachment.id,
                    "loopItemId": attachment.loop_item_id,
                    "displayName": attachment.display_name,
                    "contentType": attachment.content_type or None,
                    "sizeBytes": attachment.size_bytes,
                    "sha256": attachment.sha256,
                    "createdByUserId": attachment.created_by_user_id,
                    "createdAt": attachment.created_at,
                }
                for attachment in attachments
            ]
        }


@mcp_tool(
    name="resolve_cloud_reference",
    description=(
        "Resolve a cloud:// reference inserted by Wework @ mentions. Returns the "
        "referenced project overview, file content, TODO, or immutable delivery."
    ),
    server="delivery",
    exclude_params=["token_info"],
)
def resolve_cloud_reference(reference: str, token_info: MCPAuthInfo) -> dict[str, Any]:
    parsed = urlparse(reference)
    if parsed.scheme != "cloud" or parsed.netloc != "projects":
        return {"error": "Unsupported cloud reference"}
    parts = [part for part in parsed.path.split("/") if part]
    if not parts:
        # Generic cloud space reference: return every accessible project.
        return list_cloud_projects(token_info)
    try:
        project_id = int(parts[0])
    except ValueError:
        return {"error": "Invalid cloud project id"}

    if len(parts) == 1:
        return {
            "projectId": project_id,
            "workspace": list_cloud_workspace(project_id, token_info),
            "todos": list_cloud_todos(project_id, token_info),
        }
    if len(parts) != 3:
        return {"error": "Unsupported cloud reference path"}

    resource_type, resource_id = parts[1], parts[2]
    if resource_type == "files":
        try:
            return read_cloud_file(int(resource_id), token_info)
        except ValueError:
            return {"error": "Invalid cloud file id"}
    if resource_type == "deliveries":
        return read_delivery_markdown(resource_id, token_info)
    if resource_type == "todos":
        with SessionLocal() as db:
            item = loop_item_service.get(db, resource_id, token_info.user_id)
            if item.cloud_project_id != project_id:
                return {"error": "TODO does not belong to the referenced project"}
            return {
                "id": item.id,
                "title": item.title,
                "description": item.description,
                "status": item.status,
                "priority": item.priority,
                "assigneeUserId": item.assignee_user_id,
                "currentDeliveryId": item.current_delivery_id,
                "deliveries": list_loop_item_deliveries(item.id, token_info),
            }
    return {"error": "Unsupported cloud resource type"}
