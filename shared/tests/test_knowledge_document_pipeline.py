# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Contract tests for the reusable conversion and indexing rules.

Documents that need conversion (PDF, DOCX, ...) are converted to Markdown before
they reach the same document index as plain content. The module owns the
conversion request/result rules, the document identity used by every chunk, and
the normalized index result. These tests drive the module through a minimal
caller that never loads a Wegent product table, a database session or a task
worker.
"""

from __future__ import annotations

import re
from typing import Any

import pytest

from shared.knowledge_module import (
    ConversionEngineResult,
    ConversionRequest,
    ConvertedContent,
    DocumentChunkMetadata,
    DocumentDeleteRequest,
    DocumentIndexRequest,
    KnowledgeDocumentError,
    build_document_chunk_metadata,
    build_document_delete_request,
    conversion_output_name,
    conversion_storage_prefix,
    convert_content,
    decide_conversion_completed,
    decide_conversion_started,
    delete_document,
    finalize_index_result,
    index_document,
    normalize_document_extension,
)


class _RecordingConversionAdapter:
    """Second-service adapter: supplies the conversion engine and its formats."""

    def __init__(self, *, markdown: bytes = b"# Converted\n", supported: bool = True):
        self._markdown = markdown
        self._supported = supported
        self.calls: list[dict[str, Any]] = []

    def supports_conversion(self, extension: str) -> bool:
        return self._supported

    def convert(
        self, *, binary_data: bytes, extension: str, storage_prefix: str
    ) -> ConversionEngineResult:
        self.calls.append(
            {
                "binary_data": binary_data,
                "extension": extension,
                "storage_prefix": storage_prefix,
            }
        )
        return ConversionEngineResult(
            markdown_bytes=self._markdown,
            uploaded_images=(("img/1.png", "http://cdn.example/1.png"),),
        )


class _FailingConversionAdapter(_RecordingConversionAdapter):
    """Adapter whose engine fails the same way a converter outage does."""

    def convert(self, *, binary_data: bytes, extension: str, storage_prefix: str):
        raise RuntimeError("conversion engine unavailable")


class _RecordingIndexAdapter:
    """Second-service adapter: receives the module-built identity per chunk set."""

    def __init__(self, *, chunk_count: int = 2):
        self._chunk_count = chunk_count
        self.calls: list[dict[str, Any]] = []
        self.delete_calls: list[DocumentDeleteRequest] = []

    async def index_chunks(
        self, *, metadata: DocumentChunkMetadata, request: DocumentIndexRequest
    ) -> dict[str, Any]:
        self.calls.append({"metadata": metadata, "request": request})
        return {"indexed_count": self._chunk_count, "status": "success"}

    async def delete_document(
        self, *, request: DocumentDeleteRequest
    ) -> dict[str, Any]:
        self.delete_calls.append(request)
        return {
            "status": "deleted",
            "doc_ref": request.doc_ref,
            "knowledge_id": request.knowledge_id,
            "deleted_chunks": 2,
        }


class _FailingIndexAdapter(_RecordingIndexAdapter):
    """Adapter whose storage write fails the same way an index outage does."""

    async def index_chunks(self, *, metadata: DocumentChunkMetadata, request):
        self.calls.append({"metadata": metadata, "request": request})
        raise RuntimeError("vector store unavailable")


class _FailingDeleteAdapter(_RecordingIndexAdapter):
    """Adapter whose removal fails the same way a store outage does."""

    async def delete_document(self, *, request: DocumentDeleteRequest):
        self.delete_calls.append(request)
        raise RuntimeError("vector store unavailable")


class _EmptyStoreDeleteAdapter(_RecordingIndexAdapter):
    """Adapter for a store that already holds no chunks for the reference."""

    async def delete_document(self, *, request: DocumentDeleteRequest):
        self.delete_calls.append(request)
        return {"status": "deleted"}


def _conversion_request(**overrides: Any) -> ConversionRequest:
    defaults: dict[str, Any] = {
        "binary_data": b"%PDF-1.7 conversion source",
        "file_extension": "pdf",
        "original_filename": "quarterly-report.pdf",
        "knowledge_base_name": "Handbook",
        "document_id": 42,
    }
    defaults.update(overrides)
    return ConversionRequest(**defaults)


def test_normalize_document_extension_accepts_dotted_and_bare_forms() -> None:
    assert normalize_document_extension(".PDF") == "pdf"
    assert normalize_document_extension("Docx") == "docx"


def test_normalize_document_extension_rejects_missing_extension() -> None:
    with pytest.raises(KnowledgeDocumentError):
        normalize_document_extension("  ")


def test_conversion_output_name_keeps_the_source_stem_and_target_format() -> None:
    assert (
        conversion_output_name("quarterly-report.pdf", ".pdf")
        == "quarterly-report.pdf.md"
    )
    assert conversion_output_name("report.final.docx", "docx") == "report.final.docx.md"


def test_conversion_storage_prefix_is_scoped_to_the_converted_document() -> None:
    assert (
        conversion_storage_prefix("Handbook", 42, "quarterly-report.pdf")
        == "doc-converter/Handbook/42/quarterly-report"
    )


def test_conversion_storage_prefix_rejects_traversal_segments() -> None:
    prefix = conversion_storage_prefix("../..\\evil", 42, "../../report.pdf")

    assert prefix == "doc-converter/evil/42/report"


def test_convert_content_returns_markdown_and_the_source_identity() -> None:
    adapter = _RecordingConversionAdapter(markdown=b"# Converted body\n")

    converted = convert_content(adapter, _conversion_request())

    assert isinstance(converted, ConvertedContent)
    assert converted.markdown_bytes == b"# Converted body\n"
    assert converted.converted_name == "quarterly-report.pdf.md"
    assert converted.storage_prefix == "doc-converter/Handbook/42/quarterly-report"
    assert converted.uploaded_images == (("img/1.png", "http://cdn.example/1.png"),)
    assert adapter.calls == [
        {
            "binary_data": b"%PDF-1.7 conversion source",
            "extension": "pdf",
            "storage_prefix": "doc-converter/Handbook/42/quarterly-report",
        }
    ]


def test_convert_content_rejects_a_format_the_adapter_cannot_convert() -> None:
    adapter = _RecordingConversionAdapter(supported=False)

    with pytest.raises(KnowledgeDocumentError):
        convert_content(adapter, _conversion_request(file_extension="zip"))

    assert adapter.calls == []


def test_convert_content_requires_content_to_convert() -> None:
    adapter = _RecordingConversionAdapter()

    with pytest.raises(KnowledgeDocumentError):
        convert_content(adapter, _conversion_request(binary_data=b""))

    assert adapter.calls == []


def test_convert_content_rejects_an_empty_conversion_result() -> None:
    adapter = _RecordingConversionAdapter(markdown=b"")

    with pytest.raises(KnowledgeDocumentError):
        convert_content(adapter, _conversion_request())


def test_convert_content_propagates_engine_failures() -> None:
    with pytest.raises(RuntimeError, match="conversion engine unavailable"):
        convert_content(_FailingConversionAdapter(), _conversion_request())


def test_chunk_metadata_uses_the_document_reference_as_the_logical_identity() -> None:
    metadata = build_document_chunk_metadata(
        knowledge_id="7",
        source_file="quarterly-report.pdf.md",
        document_id=42,
    )

    assert metadata.knowledge_id == "7"
    assert metadata.doc_ref == "42"
    assert metadata.source_file == "quarterly-report.pdf.md"
    assert metadata.created_at


def test_chunk_metadata_generates_a_reference_when_the_document_is_unstored() -> None:
    metadata = build_document_chunk_metadata(
        knowledge_id="7",
        source_file="draft.md",
        document_id=None,
    )

    assert re.fullmatch(r"doc_[0-9a-f]{12}", metadata.doc_ref)


def test_finalize_index_result_normalizes_every_engine_shape() -> None:
    metadata = build_document_chunk_metadata(
        knowledge_id="7",
        source_file="release-notes.md",
        document_id=42,
        created_at="2026-09-30T00:00:00+00:00",
    )

    assert finalize_index_result({"indexed_count": 3}, metadata) == {
        "indexed_count": 3,
        "doc_ref": "42",
        "knowledge_id": "7",
        "source_file": "release-notes.md",
        "created_at": "2026-09-30T00:00:00+00:00",
        "chunk_count": 3,
    }
    assert finalize_index_result({"chunks_data": [1, 2]}, metadata)["chunk_count"] == 2
    assert (
        finalize_index_result({"chunks_data": {"total_count": 9}}, metadata)[
            "chunk_count"
        ]
        == 9
    )


async def test_index_document_passes_the_module_identity_to_the_adapter() -> None:
    adapter = _RecordingIndexAdapter(chunk_count=2)
    request = DocumentIndexRequest(
        knowledge_id="7",
        binary_data=b"# Converted body\n",
        source_file="quarterly-report.pdf.md",
        file_extension=".md",
        user_id=7,
        document_id=42,
    )

    result = await index_document(adapter, request)

    call = adapter.calls[0]
    assert call["metadata"].doc_ref == "42"
    assert call["metadata"].knowledge_id == "7"
    assert call["metadata"].source_file == "quarterly-report.pdf.md"
    assert call["request"] is request
    assert result["doc_ref"] == "42"
    assert result["chunk_count"] == 2
    assert result["knowledge_id"] == "7"
    assert result["source_file"] == "quarterly-report.pdf.md"
    assert result["created_at"] == call["metadata"].created_at


async def test_index_document_propagates_failures_without_a_result() -> None:
    adapter = _FailingIndexAdapter()
    request = DocumentIndexRequest(
        knowledge_id="7",
        binary_data=b"# Converted body\n",
        source_file="quarterly-report.pdf.md",
        file_extension=".md",
        user_id=7,
        document_id=42,
    )

    with pytest.raises(RuntimeError, match="vector store unavailable"):
        await index_document(adapter, request)

    assert adapter.calls[0]["metadata"].doc_ref == "42"


def test_build_document_delete_request_normalizes_and_validates_identity() -> None:
    request = build_document_delete_request(knowledge_id=7, doc_ref=42, user_id=None)

    assert request == DocumentDeleteRequest(
        knowledge_id="7", doc_ref="42", user_id=None
    )

    with pytest.raises(KnowledgeDocumentError):
        build_document_delete_request(knowledge_id="  ", doc_ref="42")
    with pytest.raises(KnowledgeDocumentError):
        build_document_delete_request(knowledge_id="7", doc_ref="")


async def test_delete_document_removes_the_reference_the_index_wrote() -> None:
    adapter = _RecordingIndexAdapter()
    index_request = DocumentIndexRequest(
        knowledge_id="7",
        binary_data=b"# Converted body\n",
        source_file="quarterly-report.pdf.md",
        file_extension=".md",
        user_id=7,
        document_id=42,
    )

    indexed = await index_document(adapter, index_request)
    deleted = await delete_document(
        adapter,
        build_document_delete_request(
            knowledge_id=indexed["knowledge_id"],
            doc_ref=indexed["doc_ref"],
            user_id=index_request.user_id,
        ),
    )

    assert [call.doc_ref for call in adapter.delete_calls] == ["42"]
    assert adapter.delete_calls[0].knowledge_id == "7"
    assert adapter.delete_calls[0].user_id == 7
    assert deleted == {
        "status": "deleted",
        "doc_ref": "42",
        "knowledge_id": "7",
        "deleted_chunks": 2,
    }


async def test_delete_document_repeats_without_failing_on_an_empty_store() -> None:
    adapter = _RecordingIndexAdapter()
    request = build_document_delete_request(knowledge_id=7, doc_ref="42")

    first = await delete_document(adapter, request)
    second = await delete_document(adapter, request)

    assert first == second
    assert [call.doc_ref for call in adapter.delete_calls] == ["42", "42"]


async def test_delete_document_defaults_an_empty_result_to_zero_deletions() -> None:
    adapter = _EmptyStoreDeleteAdapter()

    result = await delete_document(
        adapter, build_document_delete_request(knowledge_id=7, doc_ref="42")
    )

    assert result == {
        "status": "deleted",
        "doc_ref": "42",
        "knowledge_id": "7",
        "deleted_chunks": 0,
    }


async def test_delete_document_propagates_store_failures() -> None:
    adapter = _FailingDeleteAdapter()

    with pytest.raises(RuntimeError, match="vector store unavailable"):
        await delete_document(
            adapter, build_document_delete_request(knowledge_id=7, doc_ref="42")
        )


def test_conversion_started_accepts_only_the_current_waiting_generation() -> None:
    accepted = decide_conversion_started(
        generation=4, current_generation=4, status="pending_conversion"
    )
    assert accepted.should_execute is True
    assert accepted.reason == "conversion_started"

    assert (
        decide_conversion_started(
            generation=4, current_generation=4, status="queued"
        ).should_execute
        is True
    )
    assert (
        decide_conversion_started(
            generation=3, current_generation=4, status="pending_conversion"
        ).reason
        == "stale_generation"
    )
    assert (
        decide_conversion_started(
            generation=4, current_generation=4, status="success"
        ).reason
        == "unexpected_status_success"
    )
    missing = decide_conversion_started(
        generation=4, current_generation=None, status=None
    )
    assert missing.should_execute is False
    assert missing.reason == "document_not_found"


def test_duplicate_conversion_completion_is_refused() -> None:
    first = decide_conversion_completed(
        generation=4, current_generation=4, status="converting"
    )
    assert first.should_execute is True

    duplicate = decide_conversion_completed(
        generation=4, current_generation=4, status="queued"
    )
    assert duplicate.should_execute is False
    assert duplicate.reason == "stale_or_already_finalized"

    stale = decide_conversion_completed(
        generation=3, current_generation=4, status="converting"
    )
    assert stale.should_execute is False
    assert stale.reason == "stale_generation"
