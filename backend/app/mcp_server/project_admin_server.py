# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Wework's structured project configuration protocol boundary."""

import json
from typing import Any

from fastapi import HTTPException
from mcp.server.fastmcp import FastMCP
from mcp.server.fastmcp.exceptions import ToolError
from mcp.types import CallToolResult, TextContent, Tool
from pydantic import ValidationError

from app.mcp_server.context import get_mcp_context
from app.mcp_server.project_admin_feature import require_project_admin_write_enabled
from app.mcp_server.tool_catalog import (
    PROJECT_ADMIN_OPERATIONS,
    ProjectAdminSpaceUpdateResult,
    project_admin_output_schema,
)

ADMIN_OPERATIONS_BY_TOOL = {
    operation.tool_name: operation for operation in PROJECT_ADMIN_OPERATIONS
}
ADMIN_TOOL_NAMES = {
    *ADMIN_OPERATIONS_BY_TOOL,
    "get_project_admin_capabilities",
    "update_space",
}


class ProjectAdminMCP(FastMCP):
    """Preserve typed schemas and errors without changing other MCP servers."""

    async def list_tools(self) -> list[Tool]:
        tools = await super().list_tools()
        for tool in tools:
            operation = ADMIN_OPERATIONS_BY_TOOL.get(tool.name)
            if operation is not None:
                descriptor = operation.descriptor()
                tool.inputSchema = descriptor["inputSchema"]
                tool.outputSchema = descriptor["outputSchema"]
            elif tool.name == "update_space":
                tool.outputSchema = project_admin_output_schema(
                    ProjectAdminSpaceUpdateResult
                )
            elif tool.name == "get_project_admin_capabilities":
                tool.outputSchema = {"type": "object"}
        return tools

    async def call_tool(self, name: str, arguments: dict[str, Any]) -> Any:
        if name not in ADMIN_TOOL_NAMES:
            return await super().call_tool(name, arguments)

        from app.mcp_server.tools.wework_project_admin import project_admin_error

        try:
            if get_mcp_context() is None:
                raise HTTPException(
                    401,
                    {
                        "reason_code": "authentication_required",
                        "message": "Authentication required",
                    },
                )
            allowed = {"space_id", "project" if name == "update_space" else "request"}
            if name in {
                "get_project_config",
                "get_project_admin_capabilities",
                "get_project_members",
                "get_project_assistant_roster",
            }:
                allowed = {"space_id"}
            unknown = sorted(set(arguments) - allowed)
            if unknown:
                raise HTTPException(
                    422,
                    {
                        "reason_code": "unsupported_field",
                        "message": "Unsupported tool arguments",
                        "fields": [
                            {"path": field, "message": "Unsupported field"}
                            for field in unknown
                        ],
                    },
                )
            operation = ADMIN_OPERATIONS_BY_TOOL.get(name)
            if name == "update_space":
                project = arguments.get("project")
                require_project_admin_write_enabled(
                    space_fields=project if isinstance(project, dict) else None
                )
            elif operation is not None and not operation.read_only:
                require_project_admin_write_enabled()
            result = await self._tool_manager.call_tool(
                name, arguments, context=self.get_context(), convert_result=False
            )
            payload = json.loads(result) if isinstance(result, str) else result
        except ToolError as exc:
            if not isinstance(exc.__cause__, ValidationError):
                raise
            payload = project_admin_error(exc.__cause__)
        except HTTPException as exc:
            payload = project_admin_error(exc)

        return CallToolResult(
            content=[
                TextContent(type="text", text=json.dumps(payload, ensure_ascii=False))
            ],
            structuredContent=payload,
            isError="error" in payload,
        )
