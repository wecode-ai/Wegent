# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Online document import against the observed DingTalk MCP response contract."""

import json
from contextlib import asynccontextmanager
from datetime import datetime
from types import SimpleNamespace
from typing import Any, AsyncIterator
from unittest.mock import AsyncMock, MagicMock

import pytest
from sqlalchemy.orm import Session

from app.models.dingtalk_doc import DingtalkSyncedNode
from app.models.user import User
from app.services.dingtalk_doc_service import DingTalkDocService
from app.services.dingtalk_wikispace_service import DingTalkWikiSpaceService
from app.services.knowledge.external_document_providers import (
    DingTalkExternalDocumentProvider,
    ExternalDocumentFetchError,
    ExternalDocumentImportError,
)

McpFixture = tuple[dict[str, Any], MagicMock]


@pytest.fixture
def docs_mcp(monkeypatch: pytest.MonkeyPatch) -> McpFixture:
    """Replace only the external MCP transport and account configuration."""
    responses: dict[str, Any] = {}
    session = MagicMock()
    session.__aenter__ = AsyncMock(return_value=session)
    session.__aexit__ = AsyncMock(return_value=None)
    session.initialize = AsyncMock()
    session.list_tools = AsyncMock(return_value=SimpleNamespace(tools=[]))

    async def call_tool(name: str, arguments: dict[str, Any]) -> SimpleNamespace:
        payload = responses[name]
        if callable(payload):
            payload = payload(arguments)
        if isinstance(payload, SimpleNamespace):
            return payload
        return SimpleNamespace(
            isError=False,
            content=[SimpleNamespace(type="text", text=json.dumps(payload))],
        )

    session.call_tool = AsyncMock(side_effect=call_tool)

    @asynccontextmanager
    async def transport(**kwargs: Any) -> AsyncIterator[tuple[None, None, None]]:
        yield (None, None, None)

    monkeypatch.setattr("mcp.ClientSession", lambda *args, **kwargs: session)
    monkeypatch.setattr("mcp.client.streamable_http.streamablehttp_client", transport)
    monkeypatch.setattr(
        "app.services.user_mcp_service.UserMCPService.get_provider_service_config",
        lambda *args, **kwargs: {
            "enabled": True,
            "url": "https://mcp.example.test/dingtalk",
        },
    )
    return responses, session


@pytest.mark.asyncio
async def test_manual_refresh_makes_online_document_importable_in_place(
    test_db: Session, test_user: User, docs_mcp: McpFixture
) -> None:
    responses, _ = docs_mcp
    node = DingtalkSyncedNode(
        user_id=test_user.id,
        dingtalk_node_id="online-doc",
        name="Online document",
        doc_url="https://alidocs.dingtalk.com/i/nodes/online-doc",
        node_type="file",
        content_type="ALIDOC",
        last_synced_at=datetime.now(),
    )
    test_db.add(node)
    test_db.commit()
    original_id = node.id
    responses["list_nodes"] = {
        "success": True,
        "nodes": [
            {
                "nodeId": "online-doc",
                "name": "Online document",
                "nodeType": "file",
                "contentType": "ALIDOC",
                "extension": "adoc",
            }
        ],
    }

    await DingTalkDocService.sync_dingtalk_docs(test_user, test_db)

    nodes = DingTalkDocService.get_dingtalk_docs(test_user.id, test_db)
    assert [(item.id, item.node_type) for item in nodes] == [(original_id, "doc")]
    metadata = DingTalkExternalDocumentProvider().resolve_importable(
        test_db, test_user, "online-doc"
    )
    assert metadata["resource_id"] == "online-doc"


@pytest.fixture
async def online_source(
    test_db: Session, test_user: User, docs_mcp: McpFixture
) -> DingTalkExternalDocumentProvider:
    responses, _ = docs_mcp
    info = {
        "success": True,
        "nodeId": "online-doc",
        "name": "Online document",
        "nodeType": "file",
        "contentType": "ALIDOC",
        "extension": "adoc",
    }
    responses["list_nodes"] = {"success": True, "nodes": [info]}
    responses["get_document_info"] = info
    responses["get_document_content"] = {
        "success": True,
        "title": "Online document",
        "nodeId": "online-doc",
        "markdown": "# 正文\n\n只导入这段内容。",
    }
    await DingTalkDocService.sync_dingtalk_docs(test_user, test_db)
    return DingTalkExternalDocumentProvider()


@pytest.mark.asyncio
async def test_import_reads_metadata_then_returns_only_markdown(
    test_db: Session,
    test_user: User,
    docs_mcp: McpFixture,
    online_source: DingTalkExternalDocumentProvider,
) -> None:
    _, session = docs_mcp
    session.call_tool.reset_mock()

    content = await online_source.fetch_content(test_db, test_user, "online-doc")

    assert content.content.decode("utf-8") == "# 正文\n\n只导入这段内容。"
    assert content.file_extension == "md"
    assert [call.args for call in session.call_tool.await_args_list] == [
        ("get_document_info", {"nodeId": "online-doc"}),
        ("get_document_content", {"nodeId": "online-doc", "format": "markdown"}),
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize("source", ["docs", "wikispace"])
async def test_both_sources_only_offer_online_text_documents(
    test_db: Session, test_user: User, docs_mcp: McpFixture, source: str
) -> None:
    responses, _ = docs_mcp
    cases = [
        ("text", "file", "ALIDOC", "adoc", "doc"),
        ("lowercase", "file", "alidoc", "ADOC", "doc"),
        ("sheet", "file", "ALIDOC", "axls", "file"),
        ("table", "file", "ALIDOC", "able", "file"),
        ("pdf", "file", "FILE", "pdf", "file"),
        ("word", "file", "FILE", "docx", "file"),
        ("missing-extension", "doc", "ALIDOC", None, "file"),
        ("missing-type", "doc", None, "adoc", "file"),
        ("unknown", "other", None, None, "file"),
        ("folder", "folder", "ALIDOC", "adoc", "folder"),
    ]
    nodes = [
        {
            "nodeId": name,
            "name": name,
            "nodeType": kind,
            "contentType": content_type,
            "extension": extension,
        }
        for name, kind, content_type, extension, _ in cases
    ]
    responses["list_nodes"] = lambda args: {
        "success": True,
        "nodes": nodes if not args.get("folderId") else [],
    }
    responses["list_wikiSpaces"] = {
        "success": True,
        "wikiSpaces": [{"workspaceId": "space-1", "name": "Space"}],
    }
    if source == "docs":
        await DingTalkDocService.sync_dingtalk_docs(test_user, test_db)
        synced = DingTalkDocService.get_dingtalk_docs(test_user.id, test_db)
    else:
        await DingTalkWikiSpaceService.sync_wikispace_nodes(test_user, test_db)
        synced = DingTalkWikiSpaceService.get_wikispace_nodes(test_user.id, test_db)

    actual = {node.dingtalk_node_id: node.node_type for node in synced}
    for name, _, _, _, expected in cases:
        assert actual[name] == expected
        if expected != "doc":
            with pytest.raises(ExternalDocumentImportError):
                DingTalkExternalDocumentProvider().resolve_importable(
                    test_db, test_user, name
                )


@pytest.mark.asyncio
@pytest.mark.parametrize("extension", ["axls", "able", "pdf", None])
async def test_live_metadata_blocks_unsupported_content_even_with_stale_cache(
    test_db: Session,
    test_user: User,
    docs_mcp: McpFixture,
    online_source: DingTalkExternalDocumentProvider,
    extension: str | None,
) -> None:
    responses, session = docs_mcp
    responses["get_document_info"] = {
        **responses["get_document_info"],
        "extension": extension,
    }
    session.call_tool.reset_mock()

    with pytest.raises(ExternalDocumentFetchError, match="adoc"):
        await online_source.fetch_content(test_db, test_user, "online-doc")

    assert [call.args[0] for call in session.call_tool.await_args_list] == [
        "get_document_info"
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize("tool", ["get_document_info", "get_document_content"])
@pytest.mark.parametrize(
    "payload",
    [
        {"success": False, "markdown": "Must not import an unsuccessful response"},
        {"markdown": "Missing success flag"},
        {"success": "true", "markdown": "Non-boolean success flag"},
        [],
        "Not a JSON response object",
        SimpleNamespace(
            isError=True,
            content=[
                SimpleNamespace(
                    type="text", text='{"success": true, "markdown": "Error payload"}'
                )
            ],
        ),
        SimpleNamespace(
            isError=False, content=[SimpleNamespace(type="text", text="bad JSON")]
        ),
    ],
)
async def test_mcp_failures_are_never_imported_as_content(
    test_db: Session,
    test_user: User,
    docs_mcp: McpFixture,
    online_source: DingTalkExternalDocumentProvider,
    tool: str,
    payload: Any,
) -> None:
    responses, _ = docs_mcp
    responses[tool] = payload

    with pytest.raises(ExternalDocumentFetchError):
        await online_source.fetch_content(test_db, test_user, "online-doc")


@pytest.mark.asyncio
@pytest.mark.parametrize("markdown", [None, "", " \n\t", 123, {"text": "wrong type"}])
async def test_empty_or_invalid_markdown_is_not_imported(
    test_db: Session,
    test_user: User,
    docs_mcp: McpFixture,
    online_source: DingTalkExternalDocumentProvider,
    markdown: Any,
) -> None:
    responses, _ = docs_mcp
    responses["get_document_content"] = {"success": True, "markdown": markdown}

    with pytest.raises(ExternalDocumentFetchError, match="empty or unreadable"):
        await online_source.fetch_content(test_db, test_user, "online-doc")
