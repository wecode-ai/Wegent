# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import logging
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List

from llama_index.core import Document, SimpleDirectoryReader

from knowledge_engine.splitter import SmartSplitter, create_splitter
from knowledge_engine.splitter.config import parse_splitter_config
from knowledge_engine.splitter.splitter import SentenceSplitter
from knowledge_engine.storage.base import BaseStorageBackend
from knowledge_engine.storage.chunk_metadata import ChunkMetadata
from shared.telemetry.decorators import add_span_event

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
}


def sanitize_metadata(metadata: Dict[str, Any]) -> Dict[str, Any]:
    sanitized = {}
    for key in SAFE_METADATA_KEYS:
        if key in metadata:
            value = metadata[key]
            if value is not None:
                sanitized[key] = str(value) if not isinstance(value, str) else value
    return sanitized


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
        self.splitter = create_splitter(
            parse_splitter_config(splitter_config),
            embed_model,
            file_extension,
        )

    def index_document(
        self,
        file_path: str,
        chunk_metadata: ChunkMetadata,
        **kwargs,
    ) -> Dict:
        documents = SimpleDirectoryReader(input_files=[file_path]).load_data()
        return self._index_documents(
            documents=documents,
            chunk_metadata=chunk_metadata,
            **kwargs,
        )

    def index_from_binary(
        self,
        binary_data: bytes,
        file_extension: str,
        chunk_metadata: ChunkMetadata,
        **kwargs,
    ) -> Dict:
        with tempfile.NamedTemporaryFile(
            suffix=file_extension,
            delete=False,
        ) as tmp_file:
            tmp_file.write(binary_data)
            tmp_file_path = tmp_file.name

        try:
            documents = SimpleDirectoryReader(input_files=[tmp_file_path]).load_data()
            filename_without_ext = Path(chunk_metadata.source_file).stem
            for doc in documents:
                doc.metadata["filename"] = filename_without_ext

            return self._index_documents(
                documents=documents,
                chunk_metadata=chunk_metadata,
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

        nodes = self.splitter.split_documents(documents)
        chunk_metadata.apply_to_nodes(nodes)

        add_span_event(
            "rag.indexer.documents.split",
            {
                "knowledge_id": chunk_metadata.knowledge_id,
                "doc_ref": chunk_metadata.doc_ref,
                "node_count": str(len(nodes)),
                "splitter_type": type(self.splitter).__name__,
            },
        )

        chunks_data = self._build_chunks_metadata(nodes)
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

    def _build_chunks_metadata(self, nodes: List) -> Dict[str, Any]:
        items = []
        current_position = 0

        for idx, node in enumerate(nodes):
            text = node.text if hasattr(node, "text") else str(node)
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

        splitter_type = "semantic"
        splitter_subtype = None
        if isinstance(self.splitter, SmartSplitter):
            splitter_type = "smart"
            splitter_subtype = self.splitter._get_subtype()
        elif isinstance(self.splitter, SentenceSplitter):
            splitter_type = "sentence"

        return {
            "items": items,
            "total_count": len(items),
            "splitter_type": splitter_type,
            "splitter_subtype": splitter_subtype,
            "created_at": datetime.now(timezone.utc).isoformat(),
        }
