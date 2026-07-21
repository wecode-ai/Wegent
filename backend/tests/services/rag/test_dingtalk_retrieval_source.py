# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for the DingTalk Docs MCP retrieval adapter."""

from contextlib import AbstractAsyncContextManager
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest
from sqlalchemy.orm import Session

from app.models.dingtalk_doc import DingtalkSyncedNode
from app.models.user import User
from app.schemas.external_knowledge import ExternalKnowledgeRef
from app.services.rag.sources import RetrievalContext
from app.services.rag.sources.dingtalk import (
    DingTalkRetrievalSourceProvider,
    _allowed_node_ids,
)
from app.services.rag.sources.models import ExternalRefValidationError


class _TextContent:
    type = "text"

    def __init__(self, text: str) -> None:
        self.text = text


class _ToolResult:
    def __init__(self, payload: dict, *, is_error: bool = False) -> None:
        import json

        self.content = [_TextContent(json.dumps(payload))]
        self.isError = is_error


class _FakeHttpClient(AbstractAsyncContextManager):
    async def __aenter__(self):
        return object(), object(), None

    async def __aexit__(self, exc_type, exc, traceback):
        return None


class _FakeMcpSession(AbstractAsyncContextManager):
    def __init__(self, responses: dict[str, _ToolResult | Exception]) -> None:
        self.responses = responses
        self.calls: list[tuple[str, dict]] = []

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, traceback):
        return None

    async def initialize(self) -> None:
        return None

    async def call_tool(self, tool_name: str, arguments: dict):
        self.calls.append((tool_name, arguments))
        response = self.responses[tool_name]
        if isinstance(response, Exception):
            raise response
        return response


def _create_synced_node(
    db: Session,
    user_id: int,
    *,
    node_id: str,
    name: str,
    node_type: str = "doc",
    parent_node_id: str = "",
    source: str = "docs",
    workspace_id: str = "",
) -> DingtalkSyncedNode:
    node = DingtalkSyncedNode(
        user_id=user_id,
        dingtalk_node_id=node_id,
        name=name,
        doc_url=f"https://alidocs.dingtalk.com/i/nodes/{node_id}",
        parent_node_id=parent_node_id,
        node_type=node_type,
        workspace_id=workspace_id,
        is_active=True,
        last_synced_at=datetime.now(timezone.utc),
        source=source,
    )
    db.add(node)
    db.commit()
    db.refresh(node)
    return node


def _provider_ref(**kwargs) -> ExternalKnowledgeRef:
    return ExternalKnowledgeRef(provider="dingtalk", mode="explicit", **kwargs)


def _run_with_fake_mcp(test_db, test_user, ref, session, *, query="launch"):
    provider = DingTalkRetrievalSourceProvider()
    requested_urls: list[str] = []

    def fake_streamable_client(url: str, **kwargs):
        requested_urls.append(url)
        return _FakeHttpClient()

    async def run():
        with (
            patch(
                "app.services.rag.sources.dingtalk.SessionLocal", return_value=test_db
            ),
            patch(
                "app.services.rag.sources.dingtalk.DingTalkDocService.get_user_dingtalk_mcp_url",
                return_value="https://mcp.example.test/docs",
            ),
            patch(
                "mcp.client.streamable_http.streamablehttp_client",
                side_effect=fake_streamable_client,
            ),
            patch("mcp.ClientSession", new=lambda read, write: session),
        ):
            result = await provider.retrieve(
                query=query,
                refs=[ref],
                ctx=RetrievalContext(user_id=test_user.id),
            )
        return result, requested_urls

    return run


def test_allowlist_expands_deep_directory_without_loading_unrelated_tree(
    test_db: Session,
    test_user: User,
) -> None:
    root = _create_synced_node(
        test_db,
        test_user.id,
        node_id="deep-0",
        name="Root",
        node_type="folder",
    )
    parent_id = root.dingtalk_node_id
    expected = {parent_id}
    for depth in range(1, 41):
        node_id = f"deep-{depth}"
        _create_synced_node(
            test_db,
            test_user.id,
            node_id=node_id,
            name=node_id,
            node_type="folder" if depth < 40 else "doc",
            parent_node_id=parent_id,
        )
        expected.add(node_id)
        parent_id = node_id
    _create_synced_node(
        test_db,
        test_user.id,
        node_id="unrelated",
        name="Unrelated",
    )

    allowed = _allowed_node_ids(
        test_db,
        test_user.id,
        _provider_ref(id="docs", target_type="folder", node_id=root.dingtalk_node_id),
        [root],
    )

    assert allowed == expected


@pytest.mark.asyncio
async def test_wikispace_ref_uses_docs_mcp_and_current_search_arguments(
    test_db: Session, test_user: User
) -> None:
    _create_synced_node(
        test_db,
        test_user.id,
        node_id="wiki-doc-1",
        name="Wiki Launch Plan",
        source="wikispace",
        workspace_id="wiki-space-1",
    )
    session = _FakeMcpSession(
        {
            "search_documents": _ToolResult(
                {"documents": [{"nodeId": "wiki-doc-1", "score": 0.87}]}
            ),
            "get_document_content": _ToolResult(
                {
                    "nodeId": "wiki-doc-1",
                    "title": "Wiki Launch Plan",
                    "markdown": "Launch details",
                    "docUrl": "https://alidocs.dingtalk.com/i/nodes/wiki-doc-1",
                }
            ),
        }
    )

    result, requested_urls = await _run_with_fake_mcp(
        test_db,
        test_user,
        _provider_ref(
            id="wiki-space-1", target_type="knowledge_base", name="Product Wiki"
        ),
        session,
    )()

    assert requested_urls == [
        "https://mcp.example.test/docs",
        "https://mcp.example.test/docs",
    ]
    assert session.calls == [
        (
            "search_documents",
            {
                "keyword": "launch",
                "pageSize": 10,
                "workspaceIds": ["wiki-space-1"],
            },
        ),
        ("get_document_content", {"nodeId": "wiki-doc-1"}),
    ]
    assert result.records[0].content == "Launch details"
    assert result.records[0].source_id == "wiki-space-1"
    assert result.summary.source_statuses[0].status == "hit"


@pytest.mark.asyncio
async def test_docs_ref_searches_metadata_then_reads_document_content(
    test_db: Session, test_user: User
) -> None:
    _create_synced_node(test_db, test_user.id, node_id="doc-1", name="Launch Plan")
    session = _FakeMcpSession(
        {
            "search_documents": _ToolResult(
                {"documents": [{"nodeId": "doc-1", "title": "Metadata only"}]}
            ),
            "get_document_content": _ToolResult(
                {"nodeId": "doc-1", "title": "Launch Plan", "markdown": "Body"}
            ),
        }
    )

    result, _ = await _run_with_fake_mcp(
        test_db,
        test_user,
        _provider_ref(id="docs", target_type="knowledge_base"),
        session,
    )()

    assert result.records[0].content == "Body"
    assert result.records[0].title == "Launch Plan"
    assert session.calls[0][1] == {"keyword": "launch", "pageSize": 10}


@pytest.mark.asyncio
async def test_search_skips_folder_candidates_before_reading_content(
    test_db: Session, test_user: User
) -> None:
    _create_synced_node(
        test_db,
        test_user.id,
        node_id="folder-1",
        name="weibo-function",
        node_type="folder",
    )
    _create_synced_node(
        test_db,
        test_user.id,
        node_id="doc-1",
        name="weibo-function overview",
    )
    session = _FakeMcpSession(
        {
            "search_documents": _ToolResult(
                {
                    "documents": [
                        {"nodeId": "folder-1", "nodeType": "folder"},
                        {"nodeId": "doc-1", "nodeType": "file"},
                    ]
                }
            ),
            "get_document_content": _ToolResult(
                {
                    "nodeId": "doc-1",
                    "title": "weibo-function overview",
                    "markdown": "Actual implementation details",
                }
            ),
        }
    )

    result, _ = await _run_with_fake_mcp(
        test_db,
        test_user,
        _provider_ref(id="docs", target_type="knowledge_base"),
        session,
        query="weibo-function",
    )()

    assert [record.metadata["node_id"] for record in result.records] == ["doc-1"]
    assert [call for call in session.calls if call[0] == "get_document_content"] == [
        ("get_document_content", {"nodeId": "doc-1"})
    ]


@pytest.mark.asyncio
async def test_explicit_document_ref_reads_content_without_search(
    test_db: Session, test_user: User
) -> None:
    _create_synced_node(test_db, test_user.id, node_id="doc-1", name="Technical Plan")
    session = _FakeMcpSession(
        {
            "get_document_content": _ToolResult(
                {
                    "nodeId": "doc-1",
                    "title": "Technical Plan",
                    "markdown": "@杜江洋 owns integration",
                    "docUrl": "https://alidocs.dingtalk.com/i/nodes/doc-1",
                }
            )
        }
    )

    result, _ = await _run_with_fake_mcp(
        test_db,
        test_user,
        _provider_ref(
            id="docs",
            target_type="document",
            node_id="doc-1",
            document_id="doc-1",
            target_name="Technical Plan",
        ),
        session,
    )()

    assert [call[0] for call in session.calls] == ["get_document_content"]
    assert "杜江洋" in result.records[0].content
    assert result.records[0].source_uri.endswith("doc-1")


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "payload,warning",
    [
        ({"success": False, "errorCode": "AUTH"}, "authentication"),
        ({"success": False, "errorMsg": "invalid arguments"}, "parameters"),
    ],
)
async def test_mcp_error_envelopes_are_failed_not_no_hit(
    test_db: Session, test_user: User, payload: dict, warning: str
) -> None:
    _create_synced_node(test_db, test_user.id, node_id="doc-1", name="Launch Plan")
    session = _FakeMcpSession({"search_documents": _ToolResult(payload)})

    result, _ = await _run_with_fake_mcp(
        test_db,
        test_user,
        _provider_ref(id="docs", target_type="knowledge_base"),
        session,
    )()

    assert result.records == []
    assert result.summary.source_statuses[0].status == "failed"
    assert "no_hit" not in result.warnings
    assert warning in result.warnings[0]


@pytest.mark.asyncio
async def test_tool_missing_is_failed_and_warning_does_not_include_url(
    test_db: Session, test_user: User
) -> None:
    _create_synced_node(test_db, test_user.id, node_id="doc-1", name="Launch Plan")
    session = _FakeMcpSession(
        {"search_documents": RuntimeError("unknown tool at https://secret.example")}
    )

    result, _ = await _run_with_fake_mcp(
        test_db,
        test_user,
        _provider_ref(id="docs", target_type="knowledge_base"),
        session,
    )()

    assert result.summary.source_statuses[0].status == "failed"
    assert "https://" not in " ".join(result.warnings)


@pytest.mark.asyncio
async def test_empty_successful_search_is_no_hit(
    test_db: Session, test_user: User
) -> None:
    _create_synced_node(test_db, test_user.id, node_id="doc-1", name="Launch Plan")
    session = _FakeMcpSession({"search_documents": _ToolResult({"documents": []})})

    result, _ = await _run_with_fake_mcp(
        test_db,
        test_user,
        _provider_ref(id="docs", target_type="knowledge_base"),
        session,
    )()

    assert result.records == []
    assert result.summary.source_statuses[0].status == "no_hit"


@pytest.mark.asyncio
async def test_search_pagination_limit_is_reported_as_failed_not_no_hit(
    test_db: Session, test_user: User
) -> None:
    _create_synced_node(test_db, test_user.id, node_id="doc-1", name="Launch Plan")
    client = SimpleNamespace(
        search_documents=AsyncMock(
            side_effect=[
                SimpleNamespace(documents=[], has_more=True, next_page_token="page-2"),
                SimpleNamespace(documents=[], has_more=True, next_page_token="page-3"),
            ]
        )
    )
    provider = DingTalkRetrievalSourceProvider()
    with (
        patch("app.services.rag.sources.dingtalk.SessionLocal", return_value=test_db),
        patch(
            "app.services.rag.sources.dingtalk.DingTalkDocService.get_user_dingtalk_mcp_url",
            return_value="https://mcp.example.test/docs",
        ),
        patch(
            "app.services.rag.sources.dingtalk.DingTalkDocsMcpClient",
            return_value=client,
        ),
    ):
        result = await provider.retrieve(
            query="launch",
            refs=[_provider_ref(id="docs", target_type="knowledge_base")],
            ctx=RetrievalContext(user_id=test_user.id),
        )

    assert client.search_documents.await_count == 2
    assert result.summary.source_statuses[0].status == "failed"
    assert result.warnings == ["DingTalk Docs MCP search capability is limited"]


@pytest.mark.asyncio
async def test_search_candidates_are_limited_to_maximum(
    test_db: Session, test_user: User
) -> None:
    for index in range(12):
        _create_synced_node(
            test_db, test_user.id, node_id=f"doc-{index}", name=f"Doc {index}"
        )
    documents = [{"nodeId": f"doc-{index}"} for index in range(12)]
    session = _FakeMcpSession(
        {
            "search_documents": _ToolResult({"documents": documents}),
            "get_document_content": _ToolResult(
                {"nodeId": "doc-0", "title": "Doc", "markdown": "Body"}
            ),
        }
    )

    result, _ = await _run_with_fake_mcp(
        test_db,
        test_user,
        _provider_ref(id="docs", target_type="knowledge_base"),
        session,
    )()

    assert (
        len([call for call in session.calls if call[0] == "get_document_content"]) == 10
    )
    assert len(result.records) == 10


@pytest.mark.asyncio
async def test_folder_scope_only_reads_descendants(
    test_db: Session, test_user: User
) -> None:
    _create_synced_node(
        test_db, test_user.id, node_id="folder-1", name="Folder", node_type="folder"
    )
    _create_synced_node(
        test_db,
        test_user.id,
        node_id="doc-1",
        name="Inside",
        parent_node_id="folder-1",
    )
    _create_synced_node(test_db, test_user.id, node_id="doc-2", name="Outside")
    session = _FakeMcpSession(
        {
            "search_documents": _ToolResult(
                {"documents": [{"nodeId": "doc-1"}, {"nodeId": "doc-2"}]}
            ),
            "get_document_content": _ToolResult(
                {"nodeId": "doc-1", "title": "Inside", "markdown": "Body"}
            ),
        }
    )

    result, _ = await _run_with_fake_mcp(
        test_db,
        test_user,
        _provider_ref(id="docs", target_type="folder", node_id="folder-1"),
        session,
    )()

    assert [record.metadata["node_id"] for record in result.records] == ["doc-1"]


def test_validate_wikispace_requires_docs_mcp(
    test_db: Session, test_user: User
) -> None:
    _create_synced_node(
        test_db,
        test_user.id,
        node_id="wiki-doc-1",
        name="Wiki doc",
        source="wikispace",
        workspace_id="wiki-space-1",
    )
    gate = type(
        "Gate",
        (),
        {
            "actor_user_id": test_user.id,
            "refs": [_provider_ref(id="wiki-space-1", target_type="knowledge_base")],
        },
    )()
    with (
        patch("app.services.rag.sources.dingtalk.SessionLocal", return_value=test_db),
        patch(
            "app.services.rag.sources.dingtalk.DingTalkDocService.is_configured",
            return_value=False,
        ),
    ):
        with pytest.raises(
            ExternalRefValidationError, match="Docs MCP is not configured"
        ):
            DingTalkRetrievalSourceProvider().validate_refs(gate=gate)


@pytest.mark.asyncio
async def test_list_documents_remains_local_and_does_not_call_mcp(
    test_db: Session, test_user: User
) -> None:
    _create_synced_node(test_db, test_user.id, node_id="doc-1", name="Launch Plan")
    with patch("app.services.rag.sources.dingtalk.SessionLocal", return_value=test_db):
        result = await DingTalkRetrievalSourceProvider().list_documents(
            [_provider_ref(id="docs", target_type="knowledge_base")],
            RetrievalContext(user_id=test_user.id),
            limit=10,
            offset=0,
        )

    assert [document.document_id for document in result.documents] == ["doc-1"]
