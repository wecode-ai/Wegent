# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Task-authenticated MCP access to the internal AP knowledge provider."""

import contextvars
from typing import Annotated, NoReturn

import orjson
from mcp.server.fastmcp import FastMCP
from mcp.server.fastmcp.exceptions import ToolError
from pydantic import Field
from starlette.applications import Starlette

from app.db.session import get_db_session
from app.mcp_server.auth import TaskTokenInfo
from app.mcp_server.server import (
    McpAppSpec,
    _build_mcp_app,
    _build_transport_security_settings,
)
from app.models.user import User
from wecode.service.external_knowledge.exceptions import ExternalKnowledgeError
from wecode.service.external_knowledge.service import external_knowledge_service

AP_KNOWLEDGE_MCP_MOUNT_PATH = "/mcp/ap-knowledge"
AP_KNOWLEDGE_MCP_TRANSPORT_PATH = "/sse"

ap_knowledge_mcp_server = FastMCP(
    "wecode-ap-knowledge-mcp",
    stateless_http=True,
    json_response=True,
    streamable_http_path="/",
    transport_security=_build_transport_security_settings(),
)

_ap_request_token_info: contextvars.ContextVar[TaskTokenInfo | None] = (
    contextvars.ContextVar("_ap_request_token_info", default=None)
)


@ap_knowledge_mcp_server.tool()
async def ap_kb_search_knowledge_base(
    knowledge_base_id: str,
    query: str,
    max_results: Annotated[int, Field(ge=1, le=50)] = 10,
) -> str:
    """Search one explicitly selected WeiboAP knowledge base."""
    token_info = _ap_request_token_info.get()
    if token_info is None:
        _raise_tool_error("Authentication required", "unauthorized")

    normalized_kb_id = str(knowledge_base_id or "").strip()
    normalized_query = str(query or "").strip()
    if not normalized_kb_id:
        _raise_tool_error("knowledge_base_id is required")
    if not normalized_query:
        _raise_tool_error("query is required")
    if max_results < 1 or max_results > 50:
        _raise_tool_error("max_results must be between 1 and 50")

    try:
        with get_db_session() as db:
            user = (
                db.query(User)
                .filter(User.id == token_info.user_id, User.is_active.is_(True))
                .first()
            )
            if user is None:
                _raise_tool_error("User not found", "unauthorized")
            result = await external_knowledge_service.search(
                db,
                user,
                "ap",
                query=normalized_query,
                knowledge_base_ids=[normalized_kb_id],
                max_results=max_results,
            )
    except ExternalKnowledgeError as exc:
        _raise_tool_error(str(exc), exc.code)

    return result.model_dump_json()


def build_ap_knowledge_mcp_app(
    mount_path: str = AP_KNOWLEDGE_MCP_MOUNT_PATH,
) -> Starlette:
    """Build the internal AP MCP app at the deployment-provided mount path."""
    return _build_mcp_app(
        McpAppSpec(
            name="ap_knowledge",
            service_name="wecode-ap-knowledge-mcp",
            mount_path=mount_path,
            transport_path=AP_KNOWLEDGE_MCP_TRANSPORT_PATH,
            server=ap_knowledge_mcp_server,
            token_context=_ap_request_token_info,
            log_prefix="APKnowledge",
        )
    )


def _raise_tool_error(message: str, code: str = "bad_request") -> NoReturn:
    payload = orjson.dumps({"error": message, "code": code}).decode()
    raise ToolError(payload)
