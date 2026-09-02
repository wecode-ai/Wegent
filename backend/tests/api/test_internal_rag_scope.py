# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from unittest.mock import MagicMock

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from app.api.endpoints.internal.rag import (
    InternalRetrieveRequest,
    KnowledgeBaseScopePayload,
    _execute_prepared_internal_retrieve,
    _prepare_internal_retrieve,
    _validate_document_ids_against_scopes,
)


def _mock_db_document_rows(rows):
    db = MagicMock()
    query = db.query.return_value
    query.filter.return_value = query
    query.all.return_value = rows
    return db


def test_validate_document_ids_against_scopes_groups_allowed_documents():
    db = _mock_db_document_rows([(101, 1), (201, 2)])
    scopes = [
        KnowledgeBaseScopePayload(
            knowledge_base_id=1,
            scope_restricted=True,
            document_ids=[101],
        ),
        KnowledgeBaseScopePayload(knowledge_base_id=2, scope_restricted=False),
    ]

    grouped = _validate_document_ids_against_scopes(db, [101, 201], scopes)

    assert grouped == {1: [101], 2: [201]}


def test_validate_document_ids_against_scopes_rejects_out_of_scope_document():
    db = _mock_db_document_rows([(999, 1)])
    scopes = [
        KnowledgeBaseScopePayload(
            knowledge_base_id=1,
            scope_restricted=True,
            document_ids=[101],
        )
    ]

    with pytest.raises(HTTPException) as exc_info:
        _validate_document_ids_against_scopes(db, [999], scopes)

    assert exc_info.value.status_code == 403
    assert exc_info.value.detail["error_code"] == "document_scope_violation"


def test_internal_retrieve_request_rejects_empty_document_ids():
    with pytest.raises(ValidationError, match="document_ids must not be empty"):
        InternalRetrieveRequest(
            query="q",
            knowledge_base_ids=[1],
            document_ids=[],
        )


def test_internal_retrieve_request_accepts_search_hints() -> None:
    request = InternalRetrieveRequest(
        query="release checklist",
        knowledge_base_id=1,
        search_hints={"keywords": ["release"], "phrases": ["release checklist"]},
    )

    assert request.search_hints is not None
    assert request.search_hints.phrases == ["release checklist"]


@pytest.mark.asyncio
async def test_prepared_scoped_retrieve_empty_scope_returns_empty_total():
    request = InternalRetrieveRequest(
        query="q",
        knowledge_base_scopes=[
            KnowledgeBaseScopePayload(
                knowledge_base_id=1,
                scope_restricted=True,
                document_ids=[],
            )
        ],
    )

    prepared = _prepare_internal_retrieve(MagicMock(), request)
    result = await _execute_prepared_internal_retrieve(
        prepared,
        request.max_results,
    )

    assert result["records"] == []
    assert result["total"] == 0
    assert (
        result["message"]
        == "No documents are available in the current knowledge scope."
    )


@pytest.mark.asyncio
async def test_prepared_scoped_retrieve_includes_total_for_results(monkeypatch):
    request = InternalRetrieveRequest(
        query="q",
        max_results=2,
        knowledge_base_scopes=[
            KnowledgeBaseScopePayload(
                knowledge_base_id=1,
                scope_restricted=True,
                document_ids=[101],
            )
        ],
    )
    runtime_spec = object()

    def mock_build_query_runtime_spec(_self, **kwargs):
        assert kwargs["knowledge_base_ids"] == [1]
        assert kwargs["scope"].document_ids == [101]
        return runtime_spec

    async def mock_execute_query_with_remote_fallback(spec):
        assert spec is runtime_spec
        return {
            "mode": "rag_retrieval",
            "records": [{"content": "hit", "score": 0.9, "title": "Doc"}],
            "total_estimated_tokens": 3,
        }

    monkeypatch.setattr(
        "app.api.endpoints.internal.rag.RagRuntimeResolver.build_query_runtime_spec",
        mock_build_query_runtime_spec,
    )
    monkeypatch.setattr(
        "app.api.endpoints.internal.rag._execute_query_with_remote_fallback",
        mock_execute_query_with_remote_fallback,
    )

    prepared = _prepare_internal_retrieve(MagicMock(), request)
    result = await _execute_prepared_internal_retrieve(
        prepared,
        request.max_results,
    )

    assert result["total"] == 1
    assert result["total_estimated_tokens"] == 3


@pytest.mark.asyncio
async def test_prepared_scoped_retrieve_uses_no_scope_for_unrestricted_kb(monkeypatch):
    request = InternalRetrieveRequest(
        query="q",
        max_results=2,
        knowledge_base_scopes=[
            KnowledgeBaseScopePayload(
                knowledge_base_id=1,
                scope_restricted=False,
            )
        ],
    )
    runtime_spec = object()

    def mock_build_query_runtime_spec(_self, **kwargs):
        assert kwargs["knowledge_base_ids"] == [1]
        assert kwargs["scope"] is None
        return runtime_spec

    async def mock_execute_query_with_remote_fallback(spec):
        assert spec is runtime_spec
        return {
            "mode": "rag_retrieval",
            "records": [],
            "total_estimated_tokens": 0,
        }

    monkeypatch.setattr(
        "app.api.endpoints.internal.rag.RagRuntimeResolver.build_query_runtime_spec",
        mock_build_query_runtime_spec,
    )
    monkeypatch.setattr(
        "app.api.endpoints.internal.rag._execute_query_with_remote_fallback",
        mock_execute_query_with_remote_fallback,
    )

    prepared = _prepare_internal_retrieve(MagicMock(), request)
    result = await _execute_prepared_internal_retrieve(
        prepared,
        request.max_results,
    )

    assert result["total"] == 0
