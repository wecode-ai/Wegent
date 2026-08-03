# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from contextlib import asynccontextmanager
from types import SimpleNamespace

import pytest

from app.schemas.external_knowledge import ExternalKnowledgeRef
from app.services.rag.sources.dingtalk import DingTalkKnowledgeProvider
from app.services.rag.sources.models import ExternalRefValidationError, RetrievalContext


def _result(payload):
    import json

    return SimpleNamespace(
        content=[SimpleNamespace(type="text", text=json.dumps(payload))]
    )


class FakeSession:
    def __init__(self, responses):
        self.responses = responses
        self.calls = []

    async def call_tool(self, name, arguments):
        self.calls.append((name, arguments))
        response = self.responses[name]
        return _result(response(arguments) if callable(response) else response)


@pytest.mark.asyncio
async def test_retrieve_searches_within_selected_workspace():
    provider = DingTalkKnowledgeProvider()
    session = FakeSession(
        {
            "search_documents": {"documents": [{"nodeId": "doc-1", "name": "Plan"}]},
            "get_document_content": {"markdown": "workspace content"},
        }
    )
    ref = ExternalKnowledgeRef(
        provider="dingtalk",
        mode="explicit",
        id="space-1",
        name="研发空间",
        scope_mode="all",
    )

    records = await provider._retrieve_ref(session, "plan", ref)

    assert [record.content for record in records] == ["workspace content"]
    search_call = next(call for call in session.calls if call[0] == "search_documents")
    assert search_call[1]["workspaceIds"] == ["space-1"]


@pytest.mark.asyncio
async def test_retrieve_folder_filters_search_results_to_dynamic_descendants():
    provider = DingTalkKnowledgeProvider()
    session = FakeSession(
        {
            "list_nodes": {
                "items": [
                    {"nodeId": "doc-1", "nodeType": "doc"},
                    {"nodeId": "doc-2", "nodeType": "file"},
                ]
            },
            "search_documents": {
                "documents": [
                    {"nodeId": "outside", "name": "Outside"},
                    {"nodeId": "doc-2", "name": "Inside"},
                ]
            },
            "get_document_content": {"markdown": "folder content"},
        }
    )
    ref = ExternalKnowledgeRef(
        provider="dingtalk",
        mode="explicit",
        id="space-1",
        scope_mode="custom",
        folder_ids=["folder-1"],
    )

    records = await provider._retrieve_ref(session, "inside", ref)

    assert [record.title for record in records] == ["Inside"]
    assert (
        "list_nodes",
        {"pageSize": 50, "folderId": "folder-1", "workspaceId": "space-1"},
    ) in session.calls


@pytest.mark.asyncio
async def test_retrieve_explicit_documents_without_searching_the_container():
    provider = DingTalkKnowledgeProvider()
    session = FakeSession(
        {
            "get_document_content": {"markdown": "selected content"},
        }
    )
    ref = ExternalKnowledgeRef(
        provider="dingtalk",
        mode="explicit",
        id="docs-root",
        scope_mode="custom",
        document_ids=["doc-1"],
    )

    records = await provider._retrieve_ref(session, "question", ref)

    assert [record.content for record in records] == ["selected content"]
    assert [name for name, _ in session.calls] == ["get_document_content"]


@pytest.mark.asyncio
async def test_retrieve_all_scope_excludes_folder_descendants():
    provider = DingTalkKnowledgeProvider()
    session = FakeSession(
        {
            "list_nodes": {"items": [{"nodeId": "doc-2", "nodeType": "doc"}]},
            "search_documents": {
                "documents": [
                    {"nodeId": "doc-1", "name": "Included"},
                    {"nodeId": "doc-2", "name": "Excluded"},
                ]
            },
            "get_document_content": {"markdown": "included content"},
        }
    )
    ref = ExternalKnowledgeRef(
        provider="dingtalk",
        mode="explicit",
        id="space-1",
        scope_mode="all",
        excluded_node_ids=["folder-1"],
    )

    records = await provider._retrieve_ref(session, "plan", ref)

    assert [record.title for record in records] == ["Included"]


@pytest.mark.asyncio
async def test_list_documents_returns_documents_from_whole_workspace(monkeypatch):
    provider = DingTalkKnowledgeProvider()
    session = FakeSession(
        {
            "list_nodes": lambda arguments: (
                {"items": [{"nodeId": "doc-2", "name": "Design.md"}]}
                if arguments.get("folderId") == "folder-1"
                else {
                    "items": [
                        {"nodeId": "doc-1", "name": "Plan.docx"},
                        {
                            "nodeId": "folder-1",
                            "name": "Design",
                            "nodeType": "folder",
                        },
                    ]
                }
            ),
        }
    )

    @asynccontextmanager
    async def fake_session(_url):
        yield session

    monkeypatch.setattr(provider, "_get_mcp_url", lambda _user_id: "mcp-url")
    monkeypatch.setattr(provider, "_session", fake_session)
    ref = ExternalKnowledgeRef(
        provider="dingtalk",
        mode="explicit",
        id="space-1",
        name="研发空间",
        scope="wikispace",
        scope_mode="all",
    )

    result = await provider.list_documents(
        [ref],
        RetrievalContext(user_id=7),
        limit=50,
        offset=0,
    )

    assert [document.title for document in result.documents] == [
        "Plan.docx",
        "Design.md",
    ]
    assert result.documents[1].parent_id == "folder-1"
    assert all(document.source_id == "space-1" for document in result.documents)


def test_validate_rejects_empty_custom_scope():
    provider = DingTalkKnowledgeProvider()
    ref = ExternalKnowledgeRef(
        provider="dingtalk",
        mode="explicit",
        id="space-1",
        scope_mode="custom",
    )

    with pytest.raises(ExternalRefValidationError):
        provider.validate_refs([ref], binding_level="conversation")
