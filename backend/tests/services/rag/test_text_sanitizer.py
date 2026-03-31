# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from unittest.mock import MagicMock, patch

import pytest
from llama_index.core import Document
from llama_index.core.schema import TextNode

from app.services.rag.index.indexer import DocumentIndexer
from app.services.rag.preprocess.text_sanitizer import sanitize_text_for_indexing
from app.services.rag.storage.base import BaseStorageBackend
from app.services.rag.storage.chunk_metadata import ChunkMetadata


class _FakeStorageBackend(BaseStorageBackend):
    SUPPORTED_RETRIEVAL_METHODS = ("vector",)

    def __init__(self):
        super().__init__({})
        self.indexed_nodes = None

    def create_vector_store(self, index_name: str):
        return None

    def index_with_metadata(self, nodes, chunk_metadata, embed_model, **kwargs):
        self.indexed_nodes = nodes
        return {
            "indexed_count": len(nodes),
            "index_name": "test-index",
            "status": "success",
        }

    def retrieve(
        self,
        knowledge_id,
        query,
        embed_model,
        retrieval_setting,
        metadata_condition=None,
        **kwargs,
    ):
        return {"records": []}

    def delete_document(self, knowledge_id, doc_ref, **kwargs):
        return {"status": "success"}

    def get_document(self, knowledge_id, doc_ref, **kwargs):
        return {}

    def list_documents(self, knowledge_id, page=1, page_size=20, **kwargs):
        return {}

    def test_connection(self) -> bool:
        return True

    def get_all_chunks(self, knowledge_id, max_chunks=10000, **kwargs):
        return []


@pytest.mark.unit
class TestTextSanitizer:
    def test_replaces_markdown_image_data_url_with_alt_placeholder(self) -> None:
        text = "Before ![architecture](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAUA) after"

        result = sanitize_text_for_indexing(text)

        assert result.text == "Before ![architecture]([inline image omitted]) after"
        assert result.replacement_summary["inline_image"] == 1

    def test_replaces_markdown_image_without_alt_with_placeholder(self) -> None:
        text = "![](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAUA)"

        result = sanitize_text_for_indexing(text)

        assert result.text == "[inline image omitted]"
        assert result.replacements_count == 1

    def test_replaces_pdf_data_url_with_pdf_placeholder(self) -> None:
        text = "See data:application/pdf;base64,JVBERi0xLjQKJcTl8uXr and continue"

        result = sanitize_text_for_indexing(text)

        assert result.text == "See [inline pdf omitted] and continue"
        assert result.replacement_summary["inline_pdf"] == 1

    def test_replaces_generic_data_url_with_binary_placeholder(self) -> None:
        text = "payload=data:application/octet-stream;base64,QUJDREVGR0g="

        result = sanitize_text_for_indexing(text)

        assert result.text == "payload=[embedded binary content omitted]"
        assert result.replacement_summary["embedded_binary"] == 1

    def test_replaces_long_bare_base64_blob(self) -> None:
        blob = "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=" * 12

        result = sanitize_text_for_indexing(f"prefix {blob} suffix")

        assert result.text == "prefix [base64 content omitted] suffix"
        assert result.replacement_summary["bare_base64"] == 1

    def test_keeps_normal_text_and_short_base64_like_tokens(self) -> None:
        text = "Keep token QUJDREVGR0g= and url https://example.com intact"

        result = sanitize_text_for_indexing(text)

        assert result.text == text
        assert result.replacements_count == 0

    def test_indexer_sanitizes_documents_before_splitter(self) -> None:
        storage_backend = _FakeStorageBackend()
        splitter = MagicMock()
        splitter.split_documents.return_value = [TextNode(text="chunk")]
        with patch(
            "app.services.rag.index.indexer.create_splitter",
            return_value=splitter,
        ):
            indexer = DocumentIndexer(
                storage_backend=storage_backend,
                embed_model=MagicMock(),
            )
        documents = [
            Document(
                text="![architecture](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAUA)"
            )
        ]
        chunk_metadata = ChunkMetadata(
            knowledge_id="1",
            doc_ref="doc_1",
            source_file="test.md",
            created_at="2026-03-31T00:00:00+00:00",
        )

        indexer._index_documents(documents=documents, chunk_metadata=chunk_metadata)

        sanitized_document = splitter.split_documents.call_args.args[0][0]
        assert sanitized_document.text == "![architecture]([inline image omitted])"
