# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.services.rag.sources import (
    ExternalKnowledgeRef,
    ExternalRefValidationError,
    RetrievalContext,
)
from wecode.config.external_knowledge_config import external_knowledge_settings
from wecode.service.external_knowledge.client import ApKnowledgeMcpClient
from wecode.service.external_knowledge.providers.ap import (
    LIST_KNOWLEDGE_BASES_TOOL,
    LIST_NODES_TOOL,
    MAX_SEARCH_KNOWLEDGE_BASES,
    SEARCH_CONTENT_TOOL,
    ApExternalKnowledgeProvider,
)
from wecode.service.external_knowledge.service import external_knowledge_service
from wecode.service.external_knowledge.unavailable import (
    UnavailableExternalKnowledgeProvider,
)

pytestmark = pytest.mark.usefixtures("configure_external_knowledge")


@pytest.mark.asyncio
async def test_retrieve_maps_ap_hits_to_generic_source_fields():
    provider = ApExternalKnowledgeProvider(external_knowledge_settings)

    async def fake_call(self, name, arguments, employee_id):
        assert employee_id == "230473"
        assert name == SEARCH_CONTENT_TOOL
        assert arguments["knowledge_base_ids"] == ["kb-1"]
        assert "scope" not in arguments
        return {
            "query": arguments["query"],
            "total": 1,
            "searched_knowledge_base_ids": ["kb-1"],
            "ignored_knowledge_base_ids": [],
            "warnings": [],
            "records": [
                {
                    "content": "matched content",
                    "title": "Plan.pdf",
                    "score": 0.8,
                    "knowledge_base_id": "kb-1",
                    "knowledge_base_name": "Quarterly",
                    "document_id": "doc-1",
                }
            ],
        }

    refs = [ExternalKnowledgeRef(provider="ap", mode="explicit", id="kb-1")]
    with (
        patch.object(provider, "_resolve_employee_id", return_value="230473"),
        patch.object(ApKnowledgeMcpClient, "call_tool", fake_call),
    ):
        result = await provider.retrieve("plan", refs, RetrievalContext(user_id=1))

    assert len(result.records) == 1
    record = result.records[0]
    assert record.source_type == "ap"
    assert record.source_id == "kb-1"
    assert record.source_name == "Quarterly"
    assert record.source_uri == "ap://kb-1/doc-1"
    assert record.knowledge_base_id is None
    assert record.document_id is None


@pytest.mark.asyncio
async def test_retrieve_is_blocked_when_ap_knowledge_is_not_configured(
    monkeypatch: pytest.MonkeyPatch,
):
    monkeypatch.setattr(external_knowledge_settings, "AP_KNOWLEDGE_SYSTEM_TOKEN", "")
    provider = ApExternalKnowledgeProvider(external_knowledge_settings)
    mock_resolve_employee = MagicMock(return_value="230473")
    mock_call = AsyncMock()
    refs = [ExternalKnowledgeRef(provider="ap", mode="explicit", id="kb-1")]

    with (
        patch.object(provider, "_resolve_employee_id", mock_resolve_employee),
        patch.object(ApKnowledgeMcpClient, "call_tool", mock_call),
    ):
        with pytest.raises(Exception) as exc_info:
            await provider.retrieve("plan", refs, RetrievalContext(user_id=1))

    assert getattr(exc_info.value, "code") == "not_configured"
    mock_resolve_employee.assert_not_called()
    mock_call.assert_not_called()


@pytest.mark.asyncio
async def test_retrieve_filters_document_scoped_ap_refs():
    provider = ApExternalKnowledgeProvider(external_knowledge_settings)

    async def fake_call(self, name, arguments, employee_id):
        assert employee_id == "230473"
        assert name == SEARCH_CONTENT_TOOL
        assert arguments["knowledge_base_ids"] == ["kb-1"]
        return {
            "query": arguments["query"],
            "total": 2,
            "searched_knowledge_base_ids": ["kb-1"],
            "ignored_knowledge_base_ids": [],
            "warnings": [],
            "records": [
                {
                    "content": "ignored content",
                    "title": "Ignored.pdf",
                    "score": 0.7,
                    "knowledge_base_id": "kb-1",
                    "knowledge_base_name": "Quarterly",
                    "document_id": "doc-1",
                },
                {
                    "content": "selected content",
                    "title": "Selected.pdf",
                    "score": 0.9,
                    "knowledge_base_id": "kb-1",
                    "knowledge_base_name": "Quarterly",
                    "document_id": "doc-2",
                },
            ],
        }

    refs = [
        ExternalKnowledgeRef(
            provider="ap",
            mode="explicit",
            id="kb-1",
            target_type="document",
            node_id="document:node-2",
            document_id="doc-2",
        )
    ]
    with (
        patch.object(provider, "_resolve_employee_id", return_value="230473"),
        patch.object(ApKnowledgeMcpClient, "call_tool", fake_call),
    ):
        result = await provider.retrieve("plan", refs, RetrievalContext(user_id=1))

    assert len(result.records) == 1
    assert result.records[0].title == "Selected.pdf"
    assert result.records[0].source_uri == "ap://kb-1/doc-2"


@pytest.mark.asyncio
async def test_list_documents_filters_document_scoped_ap_refs():
    provider = ApExternalKnowledgeProvider(external_knowledge_settings)

    async def fake_call(self, name, arguments, employee_id):
        assert employee_id == "230473"
        assert name == LIST_NODES_TOOL
        assert arguments["knowledge_base_id"] == "kb-1"
        return {
            "knowledge_base_id": "kb-1",
            "knowledge_base_name": "Quarterly",
            "items": [
                {
                    "node_id": "document:doc-allowed",
                    "raw_id": "doc-allowed",
                    "name": "Allowed.pdf",
                    "node_type": "document",
                },
                {
                    "node_id": "document:doc-denied",
                    "raw_id": "doc-denied",
                    "name": "Denied.pdf",
                    "node_type": "document",
                },
            ],
        }

    refs = [
        ExternalKnowledgeRef(
            provider="ap",
            mode="explicit",
            id="kb-1",
            target_type="document",
            node_id="document:doc-allowed",
            document_id="doc-allowed",
        )
    ]
    with (
        patch.object(provider, "_resolve_employee_id", return_value="230473"),
        patch.object(ApKnowledgeMcpClient, "call_tool", fake_call),
    ):
        result = await provider.list_documents(
            refs,
            RetrievalContext(user_id=1),
            limit=20,
            offset=0,
        )

    assert [document.document_id for document in result.documents] == ["doc-allowed"]


@pytest.mark.asyncio
async def test_list_documents_pages_ap_nodes_before_slicing_results():
    provider = ApExternalKnowledgeProvider(external_knowledge_settings)
    offsets: list[int] = []

    async def fake_call(self, name, arguments, employee_id):
        assert employee_id == "230473"
        assert name == LIST_NODES_TOOL
        node_offset = arguments["offset"]
        offsets.append(node_offset)
        count = 500 if node_offset == 0 else 50
        return {
            "knowledge_base_id": "kb-1",
            "knowledge_base_name": "Quarterly",
            "total_returned": count,
            "has_more": node_offset == 0,
            "items": [
                {
                    "node_id": f"document:doc-{index}",
                    "raw_id": f"doc-{index}",
                    "name": f"Doc {index}.pdf",
                    "node_type": "document",
                }
                for index in range(node_offset, node_offset + count)
            ],
        }

    refs = [ExternalKnowledgeRef(provider="ap", mode="explicit", id="kb-1")]
    with (
        patch.object(provider, "_resolve_employee_id", return_value="230473"),
        patch.object(ApKnowledgeMcpClient, "call_tool", fake_call),
    ):
        result = await provider.list_documents(
            refs,
            RetrievalContext(user_id=1),
            limit=1,
            offset=500,
        )

    assert offsets == [0, 500]
    assert [document.document_id for document in result.documents] == ["doc-500"]


@pytest.mark.asyncio
async def test_list_documents_finds_selected_document_after_first_ap_node_page():
    provider = ApExternalKnowledgeProvider(external_knowledge_settings)
    offsets: list[int] = []

    async def fake_call(self, name, arguments, employee_id):
        assert employee_id == "230473"
        assert name == LIST_NODES_TOOL
        node_offset = arguments["offset"]
        offsets.append(node_offset)
        if node_offset == 0:
            return {
                "knowledge_base_id": "kb-1",
                "knowledge_base_name": "Quarterly",
                "total_returned": 500,
                "has_more": True,
                "items": [
                    {
                        "node_id": f"document:doc-{index}",
                        "raw_id": f"doc-{index}",
                        "name": f"Doc {index}.pdf",
                        "node_type": "document",
                    }
                    for index in range(500)
                ],
            }
        return {
            "knowledge_base_id": "kb-1",
            "knowledge_base_name": "Quarterly",
            "total_returned": 1,
            "has_more": False,
            "items": [
                {
                    "node_id": "document:doc-allowed",
                    "raw_id": "doc-allowed",
                    "name": "Allowed.pdf",
                    "node_type": "document",
                }
            ],
        }

    refs = [
        ExternalKnowledgeRef(
            provider="ap",
            mode="explicit",
            id="kb-1",
            target_type="document",
            node_id="document:doc-allowed",
            document_id="doc-allowed",
        )
    ]
    with (
        patch.object(provider, "_resolve_employee_id", return_value="230473"),
        patch.object(ApKnowledgeMcpClient, "call_tool", fake_call),
    ):
        result = await provider.list_documents(
            refs,
            RetrievalContext(user_id=1),
            limit=20,
            offset=0,
        )

    assert offsets == [0, 500]
    assert [document.document_id for document in result.documents] == ["doc-allowed"]


@pytest.mark.asyncio
async def test_retrieve_whole_ap_ref_overrides_document_filters():
    provider = ApExternalKnowledgeProvider(external_knowledge_settings)

    async def fake_call(self, name, arguments, employee_id):
        assert employee_id == "230473"
        assert name == SEARCH_CONTENT_TOOL
        assert arguments["knowledge_base_ids"] == ["kb-1"]
        return {
            "query": arguments["query"],
            "total": 2,
            "searched_knowledge_base_ids": ["kb-1"],
            "ignored_knowledge_base_ids": [],
            "warnings": [],
            "records": [
                {
                    "content": "first content",
                    "title": "First.pdf",
                    "score": 0.7,
                    "knowledge_base_id": "kb-1",
                    "knowledge_base_name": "Quarterly",
                    "document_id": "doc-1",
                },
                {
                    "content": "second content",
                    "title": "Second.pdf",
                    "score": 0.9,
                    "knowledge_base_id": "kb-1",
                    "knowledge_base_name": "Quarterly",
                    "document_id": "doc-2",
                },
            ],
        }

    refs = [
        ExternalKnowledgeRef(provider="ap", mode="explicit", id="kb-1"),
        ExternalKnowledgeRef(
            provider="ap",
            mode="explicit",
            id="kb-1",
            target_type="document",
            node_id="document:node-2",
            document_id="doc-2",
        ),
    ]
    with (
        patch.object(provider, "_resolve_employee_id", return_value="230473"),
        patch.object(ApKnowledgeMcpClient, "call_tool", fake_call),
    ):
        result = await provider.retrieve("plan", refs, RetrievalContext(user_id=1))

    assert [record.title for record in result.records] == ["First.pdf", "Second.pdf"]


@pytest.mark.asyncio
async def test_all_accessible_is_resolved_dynamically_for_each_retrieve():
    provider = ApExternalKnowledgeProvider(external_knowledge_settings)
    listed_ids = [["kb-first"], ["kb-second"]]
    searched_ids = []

    async def fake_call(self, name, arguments, employee_id):
        if name == LIST_KNOWLEDGE_BASES_TOOL:
            kb_id = listed_ids.pop(0)[0]
            return {
                "total": 1,
                "total_returned": 1,
                "has_more": False,
                "limit": arguments["limit"],
                "offset": arguments["offset"],
                "items": [
                    {
                        "knowledge_base_id": kb_id,
                        "knowledge_base_name": kb_id,
                        "scope": "organization",
                        "updated_at": "2026-06-16T00:00:00Z",
                    }
                ],
            }
        assert name == SEARCH_CONTENT_TOOL
        searched_ids.append(arguments["knowledge_base_ids"])
        return {
            "query": arguments["query"],
            "total": 0,
            "searched_knowledge_base_ids": arguments["knowledge_base_ids"],
            "ignored_knowledge_base_ids": [],
            "warnings": [],
            "records": [],
        }

    refs = [ExternalKnowledgeRef(provider="ap", mode="all_accessible")]
    with (
        patch.object(provider, "_resolve_employee_id", return_value="230473"),
        patch.object(ApKnowledgeMcpClient, "call_tool", fake_call),
    ):
        await provider.retrieve("plan", refs, RetrievalContext(user_id=1))
        await provider.retrieve("plan", refs, RetrievalContext(user_id=1))

    assert searched_ids == [["kb-first"], ["kb-second"]]


@pytest.mark.asyncio
async def test_all_accessible_applies_stable_100_limit_with_warning():
    provider = ApExternalKnowledgeProvider(external_knowledge_settings)
    search_ids = []
    ids = [f"kb-{index:03d}" for index in range(MAX_SEARCH_KNOWLEDGE_BASES + 1)]

    async def fake_call(self, name, arguments, employee_id):
        if name == LIST_KNOWLEDGE_BASES_TOOL:
            return {
                "total": len(ids),
                "total_returned": len(ids),
                "has_more": False,
                "limit": arguments["limit"],
                "offset": arguments["offset"],
                "items": [
                    {
                        "knowledge_base_id": kb_id,
                        "knowledge_base_name": kb_id,
                        "scope": "organization",
                        "updated_at": "2026-06-16T00:00:00Z",
                    }
                    for kb_id in reversed(ids)
                ],
            }
        assert name == SEARCH_CONTENT_TOOL
        search_ids.extend(arguments["knowledge_base_ids"])
        return {
            "query": arguments["query"],
            "total": 0,
            "searched_knowledge_base_ids": arguments["knowledge_base_ids"],
            "ignored_knowledge_base_ids": [],
            "warnings": [],
            "records": [],
        }

    refs = [ExternalKnowledgeRef(provider="ap", mode="all_accessible")]
    with (
        patch.object(provider, "_resolve_employee_id", return_value="230473"),
        patch.object(ApKnowledgeMcpClient, "call_tool", fake_call),
    ):
        result = await provider.retrieve("plan", refs, RetrievalContext(user_id=1))

    assert search_ids == ids[:MAX_SEARCH_KNOWLEDGE_BASES]
    assert result.summary is not None
    assert result.summary.ignored_source_ids == [ids[MAX_SEARCH_KNOWLEDGE_BASES]]
    assert result.warnings


@pytest.mark.asyncio
async def test_explicit_ap_refs_over_100_raise_before_search():
    provider = ApExternalKnowledgeProvider(external_knowledge_settings)
    refs = [
        ExternalKnowledgeRef(provider="ap", mode="explicit", id=f"kb-{index:03d}")
        for index in range(MAX_SEARCH_KNOWLEDGE_BASES + 1)
    ]
    mock_call = AsyncMock()

    with (
        patch.object(provider, "_resolve_employee_id", return_value="230473"),
        patch.object(ApKnowledgeMcpClient, "call_tool", mock_call),
    ):
        with pytest.raises(Exception) as exc_info:
            await provider.retrieve("plan", refs, RetrievalContext(user_id=1))

    assert getattr(exc_info.value, "code") == "bad_request"
    mock_call.assert_not_called()


def test_validate_refs_rejects_explicit_ap_selection_over_100():
    provider = ApExternalKnowledgeProvider(external_knowledge_settings)
    refs = [
        ExternalKnowledgeRef(provider="ap", mode="explicit", id=f"kb-{index:03d}")
        for index in range(MAX_SEARCH_KNOWLEDGE_BASES + 1)
    ]

    with pytest.raises(ExternalRefValidationError):
        provider.validate_refs(refs, binding_level="conversation")


def test_validate_refs_counts_document_refs_by_unique_ap_knowledge_base():
    provider = ApExternalKnowledgeProvider(external_knowledge_settings)
    refs = [
        ExternalKnowledgeRef(
            provider="ap",
            mode="explicit",
            id="kb-1",
            target_type="document",
            node_id=f"document:doc-{index}",
            document_id=f"doc-{index}",
        )
        for index in range(MAX_SEARCH_KNOWLEDGE_BASES + 1)
    ]

    provider.validate_refs(refs, binding_level="conversation")


def test_ap_registration_failure_registers_unavailable_provider():
    from wecode import api as wecode_api

    with (
        patch(
            "wecode.service.external_knowledge.providers.ap.ApExternalKnowledgeProvider",
            side_effect=RuntimeError("boom"),
        ),
        patch("wecode.service.external_knowledge.registry.register") as browse_register,
        patch(
            "app.services.rag.sources.retrieval_source_registry.register"
        ) as retrieval_register,
    ):
        wecode_api._register_ap_external_knowledge_provider()

    browse_provider = browse_register.call_args.args[0]
    retrieval_provider = retrieval_register.call_args.args[0]
    assert isinstance(browse_provider, UnavailableExternalKnowledgeProvider)
    assert isinstance(retrieval_provider, UnavailableExternalKnowledgeProvider)
    assert browse_provider.name == "ap"
    assert browse_provider.unavailable_reason == "boom"


@pytest.mark.asyncio
async def test_unavailable_provider_health_returns_degraded_status(
    monkeypatch: pytest.MonkeyPatch,
):
    provider = UnavailableExternalKnowledgeProvider("ap", "registration failed")

    monkeypatch.setattr(
        "wecode.service.external_knowledge.registry.get",
        lambda provider_name: provider,
    )

    result = await external_knowledge_service.health("ap")

    assert result.provider == "ap"
    assert result.ok is False
    assert result.status == "unavailable"
    assert result.message == "registration failed"


@pytest.mark.asyncio
async def test_unavailable_provider_returns_stable_error_code():
    provider = UnavailableExternalKnowledgeProvider("ap", "registration failed")

    with pytest.raises(Exception) as exc_info:
        await provider.list_knowledge_bases(
            "230473",
            scope="all",
            query=None,
            limit=1,
            offset=0,
        )

    assert getattr(exc_info.value, "code") == "provider_unavailable"
    assert getattr(exc_info.value, "status_code") == 503
