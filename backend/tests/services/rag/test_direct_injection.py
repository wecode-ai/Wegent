# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for the Backend-side direct injection module."""

import ast
from decimal import Decimal
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.services.rag import direct_injection


@pytest.fixture(autouse=True)
def set_auto_direct_injection_enabled_by_default(monkeypatch):
    """Enable auto direct injection by default for all tests in this module."""
    from app.core.config import settings

    monkeypatch.setattr(
        settings,
        "RAG_AUTO_DISABLE_DIRECT_INJECTION",
        False,
        raising=False,
    )


def _mock_document_query(db: MagicMock, rows: list[tuple]) -> MagicMock:
    """Stub the (id, kind_id, text_length) query used by direct injection."""
    query = MagicMock()
    query.select_from.return_value = query
    query.join.return_value = query
    query.filter.return_value = query
    query.all.return_value = rows
    db.query.return_value = query
    return query


def _document(
    document_id: int,
    name: str,
    content: str,
    *,
    kb_id: int = 123,
) -> dict:
    return {
        "id": document_id,
        "name": name,
        "content": content,
        "total_length": len(content),
        "offset": 0,
        "returned_length": len(content),
        "has_more": False,
        "kb_id": kb_id,
    }


def _injection_record(content: str = "full document content") -> dict:
    return {
        "content": content,
        "score": 1.0,
        "title": "doc-1",
        "metadata": {"document_id": 1, "total_length": len(content)},
        "knowledge_base_id": 123,
    }


@pytest.mark.unit
class TestGetOriginalDocumentsFromKnowledgeBase:
    """Original document reading keeps working outside the retrieval service."""

    @pytest.mark.asyncio
    async def test_returns_full_content_not_chunks(self):
        """Original documents should return complete content, not chunks."""
        db = MagicMock()
        _mock_document_query(db, [(1, 123, 100), (2, 123, 200)])

        mock_doc_read_service = MagicMock()
        mock_doc_read_service.read_documents.return_value = [
            _document(1, "doc-1.md", "This is the full content of document 1."),
            _document(2, "doc-2.md", "This is the full content of document 2."),
        ]

        with patch(
            "app.services.knowledge.document_read_service.document_read_service",
            mock_doc_read_service,
        ):
            records = await direct_injection.get_original_documents_from_knowledge_base(
                knowledge_base_ids=[123],
                db=db,
            )

        assert records is not None
        assert len(records) == 2
        assert records[0]["content"] == "This is the full content of document 1."
        assert records[0]["score"] == 1.0
        assert records[0]["title"] == "doc-1.md"
        assert records[0]["metadata"]["document_id"] == 1
        assert records[0]["knowledge_base_id"] == 123

    @pytest.mark.asyncio
    async def test_respects_document_filter(self):
        """Document IDs filter should work with original documents."""
        db = MagicMock()
        query = _mock_document_query(db, [(1, 123, 100)])

        mock_doc_read_service = MagicMock()
        mock_doc_read_service.read_documents.return_value = [
            _document(1, "doc-1.md", "Filtered document content."),
        ]

        with patch(
            "app.services.knowledge.document_read_service.document_read_service",
            mock_doc_read_service,
        ):
            records = await direct_injection.get_original_documents_from_knowledge_base(
                knowledge_base_ids=[123],
                db=db,
                document_ids=[1],
            )

        assert records is not None
        assert len(records) == 1
        assert records[0]["metadata"]["document_id"] == 1

        # Verify that the DB filter was constructed using the provided document_ids.
        filter_calls = query.filter.call_args_list
        assert len(filter_calls) >= 2, "Expected at least 2 filter calls"

        found_document_filter = False
        for call in filter_calls:
            if call.args and len(call.args) > 0:
                filter_arg = call.args[0]
                if "id" in str(filter_arg) and "1" in str(filter_arg):
                    found_document_filter = True
                    break
        assert found_document_filter, (
            f"Expected filter call with document_ids condition, "
            f"got filter calls: {filter_calls}"
        )

    @pytest.mark.asyncio
    async def test_returns_empty_list_for_no_documents(self):
        """Should return empty list when no documents exist."""
        db = MagicMock()
        _mock_document_query(db, [])

        records = await direct_injection.get_original_documents_from_knowledge_base(
            knowledge_base_ids=[123],
            db=db,
        )

        assert records == []

    @pytest.mark.asyncio
    async def test_skips_documents_with_errors(self):
        """Documents with errors should be skipped."""
        db = MagicMock()
        _mock_document_query(db, [(1, 123, 100), (2, 123, 200)])

        mock_doc_read_service = MagicMock()
        mock_doc_read_service.read_documents.return_value = [
            _document(1, "doc-1.md", "Valid content."),
            {
                "id": 2,
                "error": "Document not found",
                "error_code": "DOCUMENT_NOT_FOUND",
            },
        ]

        with patch(
            "app.services.knowledge.document_read_service.document_read_service",
            mock_doc_read_service,
        ):
            records = await direct_injection.get_original_documents_from_knowledge_base(
                knowledge_base_ids=[123],
                db=db,
            )

        assert records is not None
        assert len(records) == 1
        assert records[0]["metadata"]["document_id"] == 1

    @pytest.mark.asyncio
    async def test_truncated_document_rejects_direct_injection(self):
        """Documents at MAX_EXTRACTED_TEXT_LENGTH should be rejected."""
        from app.core.config import settings

        db = MagicMock()
        max_text_length = settings.MAX_EXTRACTED_TEXT_LENGTH
        _mock_document_query(db, [(1, 123, max_text_length)])

        records = await direct_injection.get_original_documents_from_knowledge_base(
            knowledge_base_ids=[123],
            db=db,
        )

        assert records is None

    @pytest.mark.asyncio
    async def test_document_above_limit_rejects_direct_injection(self):
        """Documents above MAX_EXTRACTED_TEXT_LENGTH should be rejected."""
        from app.core.config import settings

        db = MagicMock()
        max_text_length = settings.MAX_EXTRACTED_TEXT_LENGTH
        _mock_document_query(db, [(1, 123, max_text_length + 1000)])

        records = await direct_injection.get_original_documents_from_knowledge_base(
            knowledge_base_ids=[123],
            db=db,
        )

        assert records is None

    @pytest.mark.asyncio
    async def test_mixed_documents_reject_if_any_truncated(self):
        """If any document is truncated, the whole request should be rejected."""
        from app.core.config import settings

        db = MagicMock()
        max_text_length = settings.MAX_EXTRACTED_TEXT_LENGTH
        _mock_document_query(db, [(1, 123, 100), (2, 123, max_text_length)])

        records = await direct_injection.get_original_documents_from_knowledge_base(
            knowledge_base_ids=[123],
            db=db,
        )

        assert records is None

    @pytest.mark.asyncio
    async def test_query_by_document_ids_with_multiple_knowledge_bases(self):
        """Should support querying by document IDs across multiple knowledge bases."""
        db = MagicMock()
        _mock_document_query(db, [(1, 123, 100), (2, 456, 200)])

        mock_doc_read_service = MagicMock()
        mock_doc_read_service.read_documents.return_value = [
            _document(1, "doc-1.md", "Document from KB 123.", kb_id=123),
            _document(2, "doc-2.md", "Document from KB 456.", kb_id=456),
        ]

        with patch(
            "app.services.knowledge.document_read_service.document_read_service",
            mock_doc_read_service,
        ):
            records = await direct_injection.get_original_documents_from_knowledge_base(
                knowledge_base_ids=[123, 456],
                db=db,
                document_ids=[1, 2],
            )

        assert records is not None
        assert len(records) == 2
        assert records[0]["knowledge_base_id"] == 123
        assert records[1]["knowledge_base_id"] == 456

    @pytest.mark.asyncio
    async def test_query_with_both_kb_id_and_document_ids(self):
        """Should filter by both knowledge_base_id and document_ids when both provided."""
        db = MagicMock()
        _mock_document_query(db, [(1, 123, 100)])

        mock_doc_read_service = MagicMock()
        mock_doc_read_service.read_documents.return_value = [
            _document(1, "doc-1.md", "Filtered by both KB and doc IDs."),
        ]

        with patch(
            "app.services.knowledge.document_read_service.document_read_service",
            mock_doc_read_service,
        ):
            records = await direct_injection.get_original_documents_from_knowledge_base(
                knowledge_base_ids=[123],
                db=db,
                document_ids=[1, 2, 3],  # Only doc 1 is in KB 123
            )

        assert records is not None
        assert len(records) == 1
        assert records[0]["knowledge_base_id"] == 123

    @pytest.mark.asyncio
    async def test_no_filter_criteria_returns_empty(self):
        """Should return empty when no knowledge_base_ids provided."""
        db = MagicMock()

        records = await direct_injection.get_original_documents_from_knowledge_base(
            knowledge_base_ids=[],
            db=db,
            document_ids=None,
        )

        assert records == []

    @pytest.mark.asyncio
    async def test_empty_document_ids_is_an_empty_scope(self):
        """An explicit empty document scope resolves to no documents."""
        db = MagicMock()

        records = await direct_injection.get_original_documents_from_knowledge_base(
            knowledge_base_ids=[1],
            db=db,
            document_ids=[],
        )

        assert records == []
        db.query.assert_not_called()

    @pytest.mark.asyncio
    async def test_small_documents_use_extracted_text(self):
        """Documents under MAX_EXTRACTED_TEXT_LENGTH should use extracted_text."""
        db = MagicMock()
        _mock_document_query(db, [(1, 123, 1000), (2, 123, 2000)])

        mock_doc_read_service = MagicMock()
        mock_doc_read_service.read_documents.return_value = [
            _document(1, "small-doc-1.md", "Small document content."),
            _document(2, "small-doc-2.md", "Another small document."),
        ]

        with patch(
            "app.services.knowledge.document_read_service.document_read_service",
            mock_doc_read_service,
        ):
            records = await direct_injection.get_original_documents_from_knowledge_base(
                knowledge_base_ids=[123],
                db=db,
            )

        assert records is not None
        assert len(records) == 2
        assert records[0]["content"] == "Small document content."


@pytest.mark.unit
class TestTryDirectInjection:
    """The injection payload keeps its wire shape and rejection behaviour."""

    @pytest.mark.asyncio
    async def test_returns_original_document_payload(self):
        db = MagicMock()
        records = [_injection_record(), _injection_record("second document")]
        injected = AsyncMock(return_value=records)

        with patch.object(
            direct_injection,
            "get_original_documents_from_knowledge_base",
            injected,
        ):
            result = await direct_injection.try_direct_injection(
                knowledge_base_ids=[123],
                scope=None,
                db=db,
                route_mode="direct_injection",
                available_injection_tokens=10000,
                max_direct_chunks=500,
            )

        injected.assert_awaited_once_with(
            knowledge_base_ids=[123],
            db=db,
            document_ids=None,
        )
        assert result is not None
        assert result["mode"] == "direct_injection"
        assert result["records"] == records
        assert result["total"] == 2
        assert result["total_estimated_tokens"] == (
            direct_injection.estimate_direct_injection_tokens(records)
        )

    @pytest.mark.asyncio
    async def test_rejects_when_document_cap_exceeded(self):
        db = MagicMock()
        records = [_injection_record(), _injection_record("second document")]

        with patch.object(
            direct_injection,
            "get_original_documents_from_knowledge_base",
            AsyncMock(return_value=records),
        ):
            result = await direct_injection.try_direct_injection(
                knowledge_base_ids=[123],
                scope=None,
                db=db,
                route_mode="direct_injection",
                available_injection_tokens=None,
                max_direct_chunks=1,
            )

        assert result is None

    @pytest.mark.asyncio
    async def test_rejects_when_documents_are_truncated(self):
        db = MagicMock()

        with patch.object(
            direct_injection,
            "get_original_documents_from_knowledge_base",
            AsyncMock(return_value=None),
        ):
            result = await direct_injection.try_direct_injection(
                knowledge_base_ids=[123],
                scope=None,
                db=db,
                route_mode="direct_injection",
                available_injection_tokens=None,
                max_direct_chunks=500,
            )

        assert result is None

    @pytest.mark.asyncio
    async def test_budget_wrapper_uses_runtime_budget(self):
        from app.services.rag.runtime_specs import DirectInjectionBudget

        db = MagicMock()
        injected = AsyncMock(return_value=None)

        with patch.object(direct_injection, "try_direct_injection", injected):
            await direct_injection.try_direct_injection_with_budget(
                knowledge_base_ids=[123],
                scope=None,
                db=db,
                route_mode="direct_injection",
                budget=DirectInjectionBudget(
                    context_window=10000,
                    used_context_tokens=100,
                    reserved_output_tokens=2048,
                    context_buffer_ratio=0.1,
                    max_direct_chunks=7,
                ),
            )

        assert injected.await_args.kwargs["max_direct_chunks"] == 7
        assert injected.await_args.kwargs["available_injection_tokens"] == (
            direct_injection.calculate_available_injection_tokens(
                context_window=10000,
                used_context_tokens=100,
                reserved_output_tokens=2048,
                context_buffer_ratio=0.1,
            )
        )

    @pytest.mark.asyncio
    async def test_budget_wrapper_refuses_metadata_filters(self):
        """A metadata filter can only be honoured by retrieval."""
        db = MagicMock()
        injected = AsyncMock(return_value=None)

        with patch.object(direct_injection, "try_direct_injection", injected):
            result = await direct_injection.try_direct_injection_with_budget(
                knowledge_base_ids=[123],
                scope=None,
                db=db,
                route_mode="direct_injection",
                budget=None,
                metadata_condition={
                    "operator": "and",
                    "conditions": [{"key": "source", "operator": "eq", "value": "kb"}],
                },
            )

        assert result is None
        injected.assert_not_awaited()


@pytest.mark.unit
class TestRouteModeDecision:
    """Coarse route decisions stay in the direct injection module."""

    def test_returns_rag_retrieval_without_budget(self):
        result = direct_injection.decide_route_mode_for_chat_shell(
            query="test",
            knowledge_base_ids=[123],
            db=MagicMock(),
            route_mode="auto",
            context_window=None,
        )

        assert result == "rag_retrieval"

    def test_returns_direct_injection_when_auto_fits(self):
        db = MagicMock()

        with patch.object(
            direct_injection,
            "estimate_total_tokens_for_knowledge_bases",
            return_value=100,
        ) as mock_estimate:
            result = direct_injection.decide_route_mode_for_chat_shell(
                query="test",
                knowledge_base_ids=[123],
                db=db,
                route_mode="auto",
                context_window=10000,
                metadata_condition=None,
            )

        mock_estimate.assert_called_once_with(
            db=db,
            knowledge_base_ids=[123],
            document_ids=None,
        )
        assert result == "direct_injection"

    def test_skips_direct_injection_when_auto_disabled(self, monkeypatch):
        from app.core.config import settings

        monkeypatch.setattr(
            settings,
            "RAG_AUTO_DISABLE_DIRECT_INJECTION",
            True,
            raising=False,
        )
        db = MagicMock()

        with patch.object(
            direct_injection,
            "estimate_total_tokens_for_knowledge_bases",
            return_value=100,
        ) as mock_estimate:
            result = direct_injection.decide_route_mode_for_chat_shell(
                query="test",
                knowledge_base_ids=[123],
                db=db,
                route_mode="auto",
                context_window=10000,
            )

        mock_estimate.assert_not_called()
        assert result == "rag_retrieval"

    def test_uses_live_runtime_budget(self):
        db = MagicMock()

        with patch.object(
            direct_injection,
            "estimate_total_tokens_for_knowledge_bases",
            return_value=100,
        ):
            result = direct_injection.decide_route_mode_for_chat_shell(
                query="test",
                knowledge_base_ids=[123],
                db=db,
                route_mode="auto",
                context_window=10000,
                used_context_tokens=9990,
                reserved_output_tokens=0,
                context_buffer_ratio=0.0,
            )

        assert result == "rag_retrieval"

    def test_uses_available_budget_ratio(self):
        db = MagicMock()

        with patch.object(
            direct_injection,
            "estimate_total_tokens_for_knowledge_bases",
            return_value=1000,
        ):
            result = direct_injection.decide_route_mode_for_chat_shell(
                query="test",
                knowledge_base_ids=[123],
                db=db,
                route_mode="auto",
                context_window=10000,
                used_context_tokens=0,
                reserved_output_tokens=8000,
                context_buffer_ratio=0.0,
            )

        assert result == "rag_retrieval"

    def test_forces_rag_when_metadata_filter_exists(self):
        result = direct_injection.decide_route_mode_for_chat_shell(
            query="test",
            knowledge_base_ids=[123],
            db=MagicMock(),
            route_mode="direct_injection",
            metadata_condition={
                "operator": "and",
                "conditions": [{"key": "source", "operator": "eq", "value": "kb"}],
            },
        )

        assert result == "rag_retrieval"

    def test_estimate_total_tokens_supports_decimal_aggregate_result(self):
        """Aggregate text-length queries may return Decimal depending on the driver."""
        db = MagicMock()
        query = MagicMock()
        query.select_from.return_value = query
        query.join.return_value = query
        query.filter.return_value = query
        query.scalar.return_value = Decimal("100")
        db.query.return_value = query

        estimated_tokens = direct_injection.estimate_total_tokens_for_knowledge_bases(
            db=db,
            knowledge_base_ids=[123],
            document_ids=None,
        )

        assert estimated_tokens == 150


@pytest.mark.unit
def test_module_does_not_import_execution_kernel():
    """Direct injection must stay free of vector store / embedding / query deps."""
    source = Path(direct_injection.__file__).read_text(encoding="utf-8")
    imported_modules: set[str] = set()
    for node in ast.walk(ast.parse(source)):
        if isinstance(node, ast.Import):
            imported_modules.update(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module:
            imported_modules.add(node.module)

    forbidden_roots = ("knowledge_engine", "llama_index", "pymilvus")
    offenders = sorted(
        module for module in imported_modules if module.startswith(forbidden_roots)
    )
    assert offenders == [], f"Execution kernel imports found: {offenders}"


@pytest.mark.unit
def test_importing_module_does_not_load_execution_kernel():
    """Importing the module must not pull the execution kernel into the process."""
    import subprocess
    import sys

    backend_root = Path(direct_injection.__file__).resolve().parents[3]
    check = (
        "import sys\n"
        "import app.services.rag.direct_injection\n"
        "forbidden = ('knowledge_engine', 'llama_index', 'pymilvus')\n"
        "loaded = sorted(\n"
        "    name for name in sys.modules if name.startswith(forbidden)\n"
        ")\n"
        "assert not loaded, loaded\n"
    )
    subprocess.run(
        [sys.executable, "-c", check],
        cwd=backend_root,
        check=True,
        capture_output=True,
        text=True,
    )
