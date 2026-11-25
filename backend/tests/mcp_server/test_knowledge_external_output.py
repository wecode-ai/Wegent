# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Exercise formats and validation through the actual FastMCP protocol handler."""

import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest
from mcp.types import CallToolRequest, CallToolRequestParams, CallToolResult

from app.mcp_server.server import (
    _external_knowledge_request_user,
    external_knowledge_mcp_server,
)
from app.mcp_server.tools import knowledge_external
from app.models.knowledge import KnowledgeDocument
from app.models.subtask_context import ContextType, SubtaskContext

TEXT = '第一行\n"quoted" second line\\path'
TOOL_CASES = [
    (
        "wegent_kb_list_knowledge_bases",
        {},
        "_list_knowledge_bases_sync",
        {"items": [{"knowledge_base_id": 1, "knowledge_base_name": TEXT}]},
        {"limit": 0},
    ),
    (
        "wegent_kb_list_nodes",
        {"knowledge_base_id": 1},
        "_list_nodes_sync",
        {"knowledge_base_id": 1, "items": [{"name": TEXT}]},
        {"knowledge_base_id": 0},
    ),
    (
        "wegent_kb_get_document_content",
        {"document_id": 1},
        "_get_document_content_sync",
        {"document_id": 1, "content": TEXT},
        {"document_id": 0},
    ),
    (
        "wegent_kb_get_document_download",
        {"document_id": 1},
        "_get_document_download_sync",
        {"document_id": 1, "resource_url": "/documents/1/file", "file_name": TEXT},
        {"document_id": 0},
    ),
    (
        "wegent_kb_search_content",
        {"query": "MCP", "knowledge_base_ids": [1]},
        None,
        None,
        {"query": " ", "knowledge_base_ids": [1]},
    ),
]
RESPONSE_FORMATS = [None, "legacy", "structured"]


async def _call_mcp_tool(name: str, arguments: dict) -> CallToolResult:
    handler = external_knowledge_mcp_server._mcp_server.request_handlers[
        CallToolRequest
    ]
    response = await handler(
        CallToolRequest(
            method="tools/call",
            params=CallToolRequestParams(name=name, arguments=arguments),
        )
    )
    return response.root


def _arguments(args: dict, response_format: str | None) -> dict:
    return (
        args
        if response_format is None
        else {**args, "response_format": response_format}
    )


def _business_payload(result: CallToolResult, response_format: str | None) -> dict:
    assert result.isError is False
    assert len(result.content) == 1
    assert result.content[0].type == "text"
    if response_format == "structured":
        assert "result" not in result.structuredContent
        payload = result.structuredContent
    else:
        assert set(result.structuredContent) == {"result"}
        assert isinstance(result.structuredContent["result"], str)
        assert result.content[0].text == result.structuredContent["result"]
        payload = json.loads(result.structuredContent["result"])
    assert json.loads(result.content[0].text) == payload
    return payload


@pytest.fixture
def successful_search():
    preparation = SimpleNamespace(
        runtime_spec=object(),
        target_ids=[1],
        ignored_knowledge_base_ids=[],
        warnings=[],
        kb_name_map={1: "KB"},
    )
    with (
        patch.object(
            knowledge_external, "_prepare_search_content_sync", return_value=preparation
        ) as prepare,
        patch.object(
            knowledge_external,
            "_query_content",
            new=AsyncMock(
                return_value={
                    "records": [
                        {"content": TEXT, "knowledge_base_id": 1, "score": 1e-8}
                    ],
                    "total": 3,
                }
            ),
        ),
    ):
        yield prepare


@pytest.mark.asyncio
@pytest.mark.parametrize("response_format", RESPONSE_FORMATS)
@pytest.mark.parametrize("name,args,worker,payload,invalid_args", TOOL_CASES)
async def test_success_formats_at_the_mcp_boundary(
    name, args, worker, payload, invalid_args, response_format, successful_search
):
    token = _external_knowledge_request_user.set(
        SimpleNamespace(id=2, user_name="user")
    )
    try:
        if worker:
            with patch.object(knowledge_external, worker, return_value=payload):
                result = await _call_mcp_tool(name, _arguments(args, response_format))
        else:
            result = await _call_mcp_tool(name, _arguments(args, response_format))
    finally:
        _external_knowledge_request_user.reset(token)

    actual = _business_payload(result, response_format)
    if worker:
        assert actual == payload
        assert result.content[0].text == json.dumps(
            payload, ensure_ascii=False, separators=(",", ":")
        )
    else:
        assert actual["records"][0]["content"] == TEXT
        assert '"score":1e-8' in result.content[0].text
        assert actual["total"] == 3
        assert actual["total_returned"] == 1
        assert actual["deduplicate_by_document"] is False


@pytest.mark.asyncio
@pytest.mark.parametrize("response_format", RESPONSE_FORMATS)
@pytest.mark.parametrize("name,args,worker,payload,invalid_args", TOOL_CASES)
async def test_business_errors_use_the_selected_format_at_the_mcp_boundary(
    name, args, worker, payload, invalid_args, response_format
):
    token = _external_knowledge_request_user.set(None)
    try:
        result = await _call_mcp_tool(name, _arguments(args, response_format))
    finally:
        _external_knowledge_request_user.reset(token)
    expected_error = {
        "error": "Authentication required",
        "code": "unauthorized",
    }
    assert _business_payload(result, response_format) == expected_error
    assert result.content[0].text == json.dumps(expected_error, ensure_ascii=False)
    token = _external_knowledge_request_user.set(
        SimpleNamespace(id=2, user_name="user")
    )
    try:
        result = await _call_mcp_tool(name, _arguments(invalid_args, response_format))
    finally:
        _external_knowledge_request_user.reset(token)
    assert _business_payload(result, response_format)["code"] == "bad_request"


@pytest.mark.asyncio
async def test_tool_schemas_expose_opt_in_format_and_strict_document_mode():
    names = {case[0] for case in TOOL_CASES}
    for tool in await external_knowledge_mcp_server.list_tools():
        if tool.name not in names:
            continue
        assert tool.outputSchema["type"] == "object"
        format_schema = tool.inputSchema["properties"]["response_format"]
        assert format_schema["default"] == "legacy"
        assert format_schema["enum"] == ["legacy", "structured"]
        if tool.name == "wegent_kb_search_content":
            document_mode = tool.inputSchema["properties"]["deduplicate_by_document"]
            assert document_mode["type"] == "boolean"
            assert document_mode["default"] is False
        names.remove(tool.name)
    assert not names


@pytest.mark.asyncio
@pytest.mark.parametrize("response_format", ["legacy", "structured"])
@pytest.mark.parametrize("value", ["false", 1, None])
async def test_document_mode_rejects_non_booleans_at_the_mcp_boundary(
    value, response_format, successful_search
):
    args = {"query": "MCP", "knowledge_base_ids": [1], "deduplicate_by_document": value}
    token = _external_knowledge_request_user.set(
        SimpleNamespace(id=2, user_name="user")
    )
    try:
        result = await _call_mcp_tool(
            "wegent_kb_search_content", _arguments(args, response_format)
        )
    finally:
        _external_knowledge_request_user.reset(token)
    assert result.isError is True
    assert result.structuredContent is None
    assert "deduplicate_by_document" in result.content[0].text
    successful_search.assert_not_called()


@pytest.mark.asyncio
@pytest.mark.parametrize("response_format", ["legacy", "structured"])
@pytest.mark.parametrize("value", [True, False])
async def test_document_mode_accepts_booleans_at_the_mcp_boundary(
    value, response_format, successful_search
):
    args = {"query": "MCP", "knowledge_base_ids": [1], "deduplicate_by_document": value}
    token = _external_knowledge_request_user.set(
        SimpleNamespace(id=2, user_name="user")
    )
    try:
        result = await _call_mcp_tool(
            "wegent_kb_search_content", _arguments(args, response_format)
        )
    finally:
        _external_knowledge_request_user.reset(token)
    assert (
        _business_payload(result, response_format)["deduplicate_by_document"] is value
    )
    assert successful_search.call_args.kwargs["deduplicate_by_document"] is value


@pytest.mark.asyncio
@pytest.mark.parametrize("response_format", ["legacy", "structured"])
async def test_execution_errors_can_lack_structured_content(response_format):
    token = _external_knowledge_request_user.set(SimpleNamespace(id=2))
    try:
        with patch.object(
            knowledge_external,
            "run_in_threadpool",
            side_effect=RuntimeError("worker failed"),
        ):
            result = await _call_mcp_tool(
                "wegent_kb_list_knowledge_bases", {"response_format": response_format}
            )
    finally:
        _external_knowledge_request_user.reset(token)
    assert result.isError is True
    assert result.structuredContent is None
    assert "worker failed" in result.content[0].text


@pytest.mark.asyncio
@pytest.mark.parametrize("response_format", ["legacy", "structured"])
@pytest.mark.parametrize(
    "scenario",
    [
        "original",
        "converted",
        "empty",
        "whitespace",
        "foreign",
        "other_type",
        "converted_only",
        "foreign_original",
    ],
)
async def test_document_content_uses_trusted_text_sources_at_the_mcp_boundary(
    test_db, test_user, scenario, response_format
):
    original_text = '  original\n"body"\\path  '
    converted_text = ' 转换后的正文\n"quoted"\\path  '
    original = SubtaskContext(
        subtask_id=0,
        user_id=test_user.id + (1 if scenario == "foreign_original" else 0),
        context_type=ContextType.ATTACHMENT.value,
        name="original.md",
        status="ready",
        type_data={},
        extracted_text=original_text,
    )
    test_db.add(original)
    test_db.flush()
    converted = None
    if scenario not in ("original", "foreign_original"):
        body = {"empty": "", "whitespace": " \n\t"}.get(scenario, converted_text)
        converted = SubtaskContext(
            subtask_id=0,
            user_id=test_user.id + (1 if scenario == "foreign" else 0),
            context_type=(
                ContextType.KNOWLEDGE_BASE.value
                if scenario == "other_type"
                else ContextType.ATTACHMENT.value
            ),
            name="converted.md",
            status="ready",
            type_data={},
            extracted_text=body,
        )
        test_db.add(converted)
        test_db.flush()
    document = KnowledgeDocument(
        kind_id=1,
        attachment_id=0 if scenario == "converted_only" else original.id,
        name="notes.md",
        file_extension="md",
        file_size=1,
        user_id=test_user.id,
        source_type="file",
        source_config={"converted_attachment_id": converted.id} if converted else {},
    )
    test_db.add(document)
    test_db.flush()
    document_id = document.id
    access = SimpleNamespace(document=document, knowledge_base_id=1)
    token = _external_knowledge_request_user.set(test_user)
    try:
        with (
            patch.object(knowledge_external, "SessionLocal", return_value=test_db),
            patch.object(
                knowledge_external, "get_document_access_or_raise", return_value=access
            ),
            patch("app.services.knowledge.read_reporting.report_read"),
        ):
            result = await _call_mcp_tool(
                "wegent_kb_get_document_content",
                {"document_id": document_id, "response_format": response_format},
            )
    finally:
        _external_knowledge_request_user.reset(token)
    expected = (
        converted_text
        if scenario in ("converted", "converted_only")
        else "" if scenario == "foreign_original" else original_text
    )
    payload = _business_payload(result, response_format)
    assert payload["content"] == expected
    assert payload["content_available"] is bool(expected)
    assert payload["total_length"] == len(expected)
    assert payload["returned_length"] == len(expected)
    assert payload["offset"] == 0
    assert payload["has_more"] is False
