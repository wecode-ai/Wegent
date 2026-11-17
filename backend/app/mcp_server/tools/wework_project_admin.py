# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Project configuration tools sharing the page's CloudProjectService."""

from collections.abc import Callable
from typing import Any

from fastapi import HTTPException
from pydantic import BaseModel, ValidationError
from sqlalchemy.orm import Session

from app.db.session import SessionLocal
from app.mcp_server.auth import MCPAuthInfo
from app.mcp_server.project_admin_feature import require_project_admin_write_enabled
from app.mcp_server.tool_catalog import (
    ProjectAssistantRosterUpdate,
    ProjectAutomationUpdate,
    ProjectBoardViewsUpdate,
    ProjectDetailsUpdate,
    ProjectMembersUpdate,
    ProjectStatusesUpdate,
    ProjectStrategyUpdate,
    ProjectTagsUpdate,
    ProjectTagUpdate,
    ProjectWorkflowUpdate,
    build_project_admin_capabilities,
)
from app.mcp_server.tools.decorator import mcp_tool
from app.schemas.cloud_project import CloudProjectUpdate
from app.services.cloud_projects.service import cloud_project_service


def _space_id(db: Session, token_info: MCPAuthInfo, space_id: str) -> int:
    from app.mcp_server.tools.wework_space import _space_id as resolve_space_id

    try:
        return int(resolve_space_id(db, token_info, space_id))
    except ValueError as exc:
        raise HTTPException(
            422, {"reason_code": "invalid_config", "message": str(exc)}
        ) from exc


def project_admin_error(exc: HTTPException | ValidationError) -> dict[str, Any]:
    """Keep actionable expected errors intact through the generic MCP transport."""
    if isinstance(exc, ValidationError):
        fields = [
            {"path": list(error["loc"]), "message": error["msg"], "type": error["type"]}
            for error in exc.errors()
        ]
        return {
            "error": {
                "reason_code": (
                    "unsupported_field"
                    if any(error["type"] == "extra_forbidden" for error in exc.errors())
                    else "invalid_config"
                ),
                "message": "Project configuration failed validation",
                "status_code": 422,
                "fields": fields,
            }
        }
    detail = exc.detail
    codes = {403: "permission_denied", 404: "not_found", 409: "version_conflict"}
    error = {
        "reason_code": codes.get(exc.status_code, "invalid_config"),
        "message": str(detail),
        "status_code": exc.status_code,
        "fields": [],
    }
    if isinstance(detail, dict):
        error.update({key: value for key, value in detail.items() if key in error})
    return {"error": error}


def _read(
    token_info: MCPAuthInfo,
    space_id: str,
    reader: Callable[[Session, int, int], dict[str, Any]],
) -> dict[str, Any]:
    try:
        with SessionLocal() as db:
            return reader(db, _space_id(db, token_info, space_id), token_info.user_id)
    except (HTTPException, ValidationError) as exc:
        return project_admin_error(exc)


def _write(
    token_info: MCPAuthInfo,
    request: BaseModel | dict[str, Any],
    request_type: type[BaseModel],
    space_id: str,
) -> dict[str, Any]:
    try:
        require_project_admin_write_enabled()
        validated = request_type.model_validate(request)
        values = CloudProjectUpdate.model_validate(
            validated.model_dump(exclude_unset=True)
        )
        with SessionLocal() as db:
            project = cloud_project_service.update(
                db,
                _space_id(db, token_info, space_id),
                token_info.user_id,
                values,
            )
            return cloud_project_service.admin_result(project)
    except (HTTPException, ValidationError) as exc:
        return project_admin_error(exc)


@mcp_tool(server="wework_space")
def get_project_admin_capabilities(
    token_info: MCPAuthInfo, space_id: str = ""
) -> dict[str, Any]:
    """Discover authorized project configuration operations and exact schemas."""
    return _read(token_info, space_id, build_project_admin_capabilities)


@mcp_tool(server="wework_space")
def get_project_config(token_info: MCPAuthInfo, space_id: str = "") -> dict[str, Any]:
    """Read safe project configuration, projectVersion and current revision."""
    return _read(token_info, space_id, cloud_project_service.admin_config)


def _roster_read(
    db: Session, project_id: int, user_id: int, key: str
) -> dict[str, Any]:
    snapshot = cloud_project_service.admin_config(db, project_id, user_id)
    return {
        **snapshot,
        "configuration": {key: snapshot["configuration"][key]},
    }


@mcp_tool(server="wework_space")
def get_project_members(token_info: MCPAuthInfo, space_id: str = "") -> dict[str, Any]:
    """Read project permission roles and functional responsibilities with revisions."""
    return _read(
        token_info, space_id, lambda db, pid, uid: _roster_read(db, pid, uid, "members")
    )


@mcp_tool(server="wework_space")
def get_project_assistant_roster(
    token_info: MCPAuthInfo, space_id: str = ""
) -> dict[str, Any]:
    """Read visible assistant bindings without private prompts, memory or credentials."""
    return _read(
        token_info,
        space_id,
        lambda db, pid, uid: _roster_read(db, pid, uid, "assistant_roster"),
    )


@mcp_tool(server="wework_space")
def update_project_members(
    token_info: MCPAuthInfo, request: ProjectMembersUpdate, space_id: str = ""
) -> dict[str, Any]:
    """Update permission roles and functional responsibilities in one audited transaction."""
    return _write(token_info, request, ProjectMembersUpdate, space_id)


@mcp_tool(server="wework_space")
def update_project_assistant_roster(
    token_info: MCPAuthInfo, request: ProjectAssistantRosterUpdate, space_id: str = ""
) -> dict[str, Any]:
    """Update project assistant activation and responsibilities with resource checks."""
    return _write(token_info, request, ProjectAssistantRosterUpdate, space_id)


@mcp_tool(server="wework_space")
def update_project_details(
    token_info: MCPAuthInfo, request: ProjectDetailsUpdate, space_id: str = ""
) -> dict[str, Any]:
    """Update project name or description with version, dry-run and audit."""
    return _write(token_info, request, ProjectDetailsUpdate, space_id)


@mcp_tool(server="wework_space")
def update_project_tags(
    token_info: MCPAuthInfo, request: ProjectTagsUpdate, space_id: str = ""
) -> dict[str, Any]:
    """Replace project tags and clean Issue and saved-view references atomically."""
    return _write(token_info, request, ProjectTagsUpdate, space_id)


@mcp_tool(server="wework_space")
def change_project_tag(
    token_info: MCPAuthInfo, request: ProjectTagUpdate, space_id: str = ""
) -> dict[str, Any]:
    """Rename or delete one tag with an atomic reference update and impact diff."""
    return _write(token_info, request, ProjectTagUpdate, space_id)


@mcp_tool(server="wework_space")
def update_project_board_views(
    token_info: MCPAuthInfo, request: ProjectBoardViewsUpdate, space_id: str = ""
) -> dict[str, Any]:
    """Replace typed status, tag and unmatched board columns and saved filters."""
    return _write(token_info, request, ProjectBoardViewsUpdate, space_id)


@mcp_tool(server="wework_space")
def update_project_strategy(
    token_info: MCPAuthInfo, request: ProjectStrategyUpdate, space_id: str = ""
) -> dict[str, Any]:
    """Update collaboration policy revision while preserving running Issue snapshots."""
    return _write(token_info, request, ProjectStrategyUpdate, space_id)


@mcp_tool(server="wework_space")
def update_project_statuses(
    token_info: MCPAuthInfo, request: ProjectStatusesUpdate, space_id: str = ""
) -> dict[str, Any]:
    """Update validated board statuses with a version lock and audit."""
    return _write(token_info, request, ProjectStatusesUpdate, space_id)


@mcp_tool(server="wework_space")
def update_project_workflow(
    token_info: MCPAuthInfo, request: ProjectWorkflowUpdate, space_id: str = ""
) -> dict[str, Any]:
    """Update the typed workflow definition for future Issues with revision evidence."""
    return _write(token_info, request, ProjectWorkflowUpdate, space_id)


@mcp_tool(server="wework_space")
def update_project_automation(
    token_info: MCPAuthInfo, request: ProjectAutomationUpdate, space_id: str = ""
) -> dict[str, Any]:
    """Update project retry and pull request automation through the shared service."""
    return _write(token_info, request, ProjectAutomationUpdate, space_id)
