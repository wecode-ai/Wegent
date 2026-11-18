# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Exercise the FastMCP boundary, including serialization and output schemas."""

import json
from types import SimpleNamespace
from unittest.mock import patch

import pytest

from app.mcp_server.server import (
    _external_knowledge_request_user,
    external_knowledge_mcp_server,
)
from app.mcp_server.tools import knowledge_external

TOOL_ARGS = [
    ("wegent_kb_list_knowledge_bases", {}),
    ("wegent_kb_list_nodes", {"knowledge_base_id": 1}),
    ("wegent_kb_get_document_content", {"document_id": 1}),
    ("wegent_kb_get_document_download", {"document_id": 1}),
    ("wegent_kb_search_content", {"query": "MCP", "knowledge_base_ids": [1]}),
]


@pytest.mark.asyncio
@pytest.mark.parametrize("name,args", TOOL_ARGS)
async def test_errors_are_objects_at_the_mcp_boundary(name, args):
    token = _external_knowledge_request_user.set(None)
    try:
        content, structured = await external_knowledge_mcp_server.call_tool(name, args)
    finally:
        _external_knowledge_request_user.reset(token)

    assert structured == {"error": "Authentication required", "code": "unauthorized"}
    assert json.loads(content[0].text) == structured


@pytest.mark.asyncio
async def test_tool_schemas_describe_objects_instead_of_json_strings():
    names = {name for name, _ in TOOL_ARGS}
    tools = await external_knowledge_mcp_server.list_tools()
    for tool in tools:
        if tool.name in names:
            assert tool.outputSchema["type"] == "object"
            assert "result" not in tool.outputSchema.get("properties", {})
            names.remove(tool.name)
    assert not names


@pytest.mark.asyncio
async def test_document_content_preserves_text_without_a_json_string_wrapper():
    text = '第一行\n"quoted" second line\\path'
    result = {
        "name": "notes.md",
        "content": text,
        "offset": 0,
        "returned_length": len(text),
        "total_length": len(text),
        "has_more": False,
    }
    user = SimpleNamespace(id=2)
    access = SimpleNamespace(
        knowledge_base_id=1,
        document=SimpleNamespace(index_status="success"),
    )
    token = _external_knowledge_request_user.set(user)
    try:
        with (
            patch.object(knowledge_external, "SessionLocal"),
            patch.object(
                knowledge_external, "get_document_access_or_raise", return_value=access
            ),
            patch.object(
                knowledge_external.document_read_service,
                "read_documents",
                return_value=[result],
            ),
            patch("app.services.knowledge.read_reporting.report_read"),
        ):
            content, structured = await external_knowledge_mcp_server.call_tool(
                "wegent_kb_get_document_content", {"document_id": 1}
            )
    finally:
        _external_knowledge_request_user.reset(token)

    assert structured["document_id"] == 1
    assert structured["content"] == text
    assert json.loads(content[0].text) == structured
