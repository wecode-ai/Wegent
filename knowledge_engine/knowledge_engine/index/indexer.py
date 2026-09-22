# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import logging
import mimetypes
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List

from llama_index.core import Document, SimpleDirectoryReader
from llama_index.core.schema import BaseNode

from knowledge_engine.embedding.capabilities import embed_model_supports_image_input
from knowledge_engine.excel import EXCEL_SOURCE_EXTENSIONS
from knowledge_engine.ingestion.pipeline import (
    build_ingestion_result,
    prepare_ingestion,
)
from knowledge_engine.readers import ExcelSourceReader
from knowledge_engine.storage.base import (
    BaseStorageBackend,
    resolve_display_text,
)
from knowledge_engine.storage.chunk_metadata import ChunkMetadata
from knowledge_engine.text_sanitizer import sanitize_text_for_indexing
from shared.telemetry.decorators import add_span_event
from shared.utils.xmind_parser import parse_xmind_to_markdown

logger = logging.getLogger(__name__)

SAFE_METADATA_KEYS = {
    "filename",
    "file_path",
    "file_name",
    "file_type",
    "file_size",
    "creation_date",
    "last_modified_date",
    "page_label",
    "page_number",
    "sheet_name",
}


def sanitize_metadata(metadata: Dict[str, Any]) -> Dict[str, Any]:
    sanitized = {}
    for key in SAFE_METADATA_KEYS:
        if key in metadata:
            value = metadata[key]
            if value is not None:
                sanitized[key] = str(value) if not isinstance(value, str) else value
    return sanitized


def sanitize_documents(
    documents: List[Document],
    *,
    sanitize_inline_images: bool,
) -> List[Document]:
    """Sanitize document text before chunking."""
    for doc in documents:
        if "sheet_name" in doc.metadata:
            # Canonical Excel row text must survive verbatim: the row-aware
            # splitter parses it strictly and any rewrite fails indexing.
            # Presence, not truthiness: an empty sheet name is still an
            # Excel document, and sanitizer rewrites of data-URL-looking
            # cell values would fail the strict parser.
            continue
        result = sanitize_text_for_indexing(
            doc.text,
            sanitize_inline_images=sanitize_inline_images,
        )
        if result.replacements_count == 0:
            continue

        add_span_event(
            "rag.indexer.documents.sanitized",
            {
                "replacements_count": str(result.replacements_count),
                "replacement_summary": str(result.replacement_summary),
            },
        )
        doc.set_content(result.text)

    return documents


def resolve_extension(suffix: str | None, default: str | None = None) -> str | None:
    """Resolve the effective extension at one place; empty means absent.

    Both arguments normalize to lowercase: every consumer dispatches on the
    resolved value, so an uppercase default must not leak dispatch decisions
    that disagree with what a normalized lookup would find.
    """
    normalized = (suffix or "").lower()
    return normalized or (default or "").lower() or None


def load_source_documents(
    file_path: str,
    file_extension: str | None,
) -> List[Document]:
    """Load source documents with the reader chosen by the resolved extension.

    The caller resolves the extension once and passes it down; reader and
    splitter dispatch share that single fact, so a suffixless file whose
    content the caller declared as Excel is still read by the structure-
    aware reader instead of being decoded as raw bytes.
    """
    if file_extension in EXCEL_SOURCE_EXTENSIONS:
        documents = ExcelSourceReader().load_data(Path(file_path))
    else:
        documents = SimpleDirectoryReader(
            input_files=[file_path],
        ).load_data()
    # The reader-direct branch skips SimpleDirectoryReader's file metadata;
    # restore the same fields (dates in local time, like the reader's) on
    # every document so sanitize_metadata keeps one shape regardless of
    # which reader produced it.
    stat = Path(file_path).stat()
    file_metadata = {
        "file_path": str(file_path),
        "file_name": Path(file_path).name,
        "file_type": mimetypes.guess_type(str(file_path))[0],
        "file_size": stat.st_size,
        "creation_date": datetime.fromtimestamp(stat.st_ctime).strftime("%Y-%m-%d"),
        "last_modified_date": datetime.fromtimestamp(stat.st_mtime).strftime(
            "%Y-%m-%d"
        ),
    }
    for document in documents:
        for key, value in file_metadata.items():
            if value is not None:
                document.metadata.setdefault(key, value)
    return documents


class DocumentIndexer:
    def __init__(
        self,
        storage_backend: BaseStorageBackend,
        embed_model,
        splitter_config: dict | None = None,
        file_extension: str | None = None,
    ):
        self.storage_backend = storage_backend
        self.embed_model = embed_model
        self.file_extension = file_extension
        ingestion_preparation = prepare_ingestion(
            splitter_config,
            file_extension=file_extension,
        )
        self.splitter_config = ingestion_preparation.normalized_splitter_config

    def index_document(
        self,
        file_path: str,
        chunk_metadata: ChunkMetadata,
        **kwargs,
    ) -> Dict:
        # Resolve the extension once at the entry: the actual file suffix
        # wins and the constructor value is only a default. Reader and
        # splitter both consume this single resolved fact, so dispatch
        # cannot disagree and a reused indexer never leaks state across
        # files.
        file_extension = resolve_extension(Path(file_path).suffix, self.file_extension)
        documents = load_source_documents(file_path, file_extension)
        return self._index_documents(
            documents=documents,
            chunk_metadata=chunk_metadata,
            file_extension=file_extension,
            **kwargs,
        )

    def index_from_binary(
        self,
        binary_data: bytes,
        file_extension: str,
        chunk_metadata: ChunkMetadata,
        **kwargs,
    ) -> Dict:
        # Same precedence as index_document: the caller-declared extension
        # describes the bytes and the constructor value is only a default.
        effective_extension = resolve_extension(file_extension, self.file_extension)
        # XMind files require special parsing: extract content.json from the ZIP
        # archive and convert the topic tree to Markdown before indexing.
        if effective_extension == ".xmind":
            markdown_text = parse_xmind_to_markdown(binary_data)
            filename_without_ext = Path(chunk_metadata.source_file).stem
            documents = [
                Document(
                    text=markdown_text,
                    metadata={"filename": filename_without_ext},
                )
            ]
            return self._index_documents(
                documents=documents,
                chunk_metadata=chunk_metadata,
                file_extension=effective_extension,
                **kwargs,
            )

        with tempfile.NamedTemporaryFile(
            suffix=effective_extension or "",
            delete=False,
        ) as tmp_file:
            tmp_file.write(binary_data)
            tmp_file_path = tmp_file.name

        try:
            documents = load_source_documents(tmp_file_path, effective_extension)
            filename_without_ext = Path(chunk_metadata.source_file).stem
            for doc in documents:
                doc.metadata["filename"] = filename_without_ext

            return self._index_documents(
                documents=documents,
                chunk_metadata=chunk_metadata,
                file_extension=effective_extension,
                **kwargs,
            )
        finally:
            try:
                Path(tmp_file_path).unlink()
            except Exception as exc:
                logger.warning(
                    "Failed to delete temporary file %s: %s",
                    tmp_file_path,
                    exc,
                )

    def _index_documents(
        self,
        documents: List[Document],
        chunk_metadata: ChunkMetadata,
        file_extension: str | None = None,
        **kwargs,
    ) -> Dict:
        add_span_event(
            "rag.indexer.documents.received",
            {
                "knowledge_id": chunk_metadata.knowledge_id,
                "doc_ref": chunk_metadata.doc_ref,
                "source_file": chunk_metadata.source_file,
                "document_count": str(len(documents)),
            },
        )

        for doc in documents:
            doc.metadata = sanitize_metadata(doc.metadata)

        documents = sanitize_documents(
            documents,
            sanitize_inline_images=not embed_model_supports_image_input(
                self.embed_model
            ),
        )

        ingestion_result = build_ingestion_result(
            documents=documents,
            splitter_config=self.splitter_config,
            file_extension=file_extension,
            embed_model=self.embed_model,
        )
        parser_subtype = ingestion_result.parser_subtype

        parent_nodes = ingestion_result.parent_nodes
        nodes = ingestion_result.index_nodes

        if parent_nodes is not None:
            chunk_metadata.apply_to_nodes(parent_nodes)
            self.storage_backend.save_parent_nodes(
                knowledge_id=chunk_metadata.knowledge_id,
                parent_nodes=parent_nodes,
                **kwargs,
            )

        chunk_metadata.apply_to_nodes(nodes)

        add_span_event(
            "rag.indexer.documents.split",
            {
                "knowledge_id": chunk_metadata.knowledge_id,
                "doc_ref": chunk_metadata.doc_ref,
                "node_count": str(len(nodes)),
                "splitter_type": self.splitter_config.chunk_strategy,
            },
        )

        chunks_data = self._build_chunks_metadata(
            nodes,
            parser_subtype=parser_subtype,
        )
        result = self.storage_backend.index_with_metadata(
            nodes=nodes,
            chunk_metadata=chunk_metadata,
            embed_model=self.embed_model,
            **kwargs,
        )

        result.update(
            {
                "doc_ref": chunk_metadata.doc_ref,
                "knowledge_id": chunk_metadata.knowledge_id,
                "source_file": chunk_metadata.source_file,
                "chunk_count": len(nodes),
                "created_at": chunk_metadata.created_at,
                "chunks_data": chunks_data,
            }
        )
        return result

    def _build_chunks_metadata(
        self,
        nodes: List[BaseNode],
        *,
        parser_subtype: str | None = None,
    ) -> Dict[str, Any]:
        items = []
        current_position = 0

        for idx, node in enumerate(nodes):
            text = resolve_display_text(
                node.metadata,
                fallback=node.text or "",
            )
            text_length = len(text)
            token_count = text_length // 4
            items.append(
                {
                    "index": idx,
                    "content": text,
                    "token_count": token_count,
                    "start_position": current_position,
                    "end_position": current_position + text_length,
                }
            )
            current_position += text_length

        qa_pair_count = sum(
            1
            for node in nodes
            if getattr(node, "metadata", {}).get("node_role") == "qa_pair"
        )

        return {
            "items": items,
            "total_count": len(items),
            "splitter_type": self.splitter_config.chunk_strategy,
            "splitter_subtype": parser_subtype,
            "qa_pair_count": qa_pair_count if parser_subtype == "qa_pair" else 0,
            "created_at": datetime.now(timezone.utc).isoformat(),
        }
