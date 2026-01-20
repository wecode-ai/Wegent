# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Document indexing orchestration.
"""

import logging
import tempfile
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

from llama_index.core import Document, SimpleDirectoryReader

from app.schemas.rag import SmartSplitterConfig, SplitterConfig
from app.services.rag.splitter import SemanticSplitter, SentenceSplitter, SmartSplitter
from app.services.rag.splitter.factory import create_splitter
from app.services.rag.splitter.validators import (
    format_validation_error,
    validate_markdown_chunks,
)
from app.services.rag.storage.base import BaseStorageBackend
from app.services.rag.utils.tokenizer import count_tokens

logger = logging.getLogger(__name__)

# Metadata keys to preserve during indexing
# These are simple string/number fields that won't cause ES mapping conflicts
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
    """
    Sanitize document metadata to prevent Elasticsearch mapping conflicts.

    LlamaIndex's SimpleDirectoryReader extracts complex nested metadata from
    documents (especially PPTX, DOCX, etc.) that can cause ES dynamic mapping
    conflicts when field values have inconsistent types across documents.

    This function:
    1. Keeps only safe, simple metadata fields
    2. Converts all values to strings to prevent type inference issues
    3. Removes nested structures that cause mapping conflicts

    Args:
        metadata: Original metadata dict from LlamaIndex document

    Returns:
        Sanitized metadata dict with only safe fields
    """
    sanitized = {}
    for key in SAFE_METADATA_KEYS:
        if key in metadata:
            value = metadata[key]
            # Convert to string to prevent type inference issues
            if value is not None:
                sanitized[key] = str(value) if not isinstance(value, str) else value
    return sanitized


def _build_chunks_data(
    nodes: list,
    splitter_type: str,
    embedding_model_name: str,
) -> Dict[str, Any]:
    """
    Build chunks data structure for DB storage.

    Args:
        nodes: List of nodes from splitting
        splitter_type: Type of splitter used
        embedding_model_name: Name of embedding model for token counting

    Returns:
        Dict with chunks data structure
    """
    items = []
    for idx, node in enumerate(nodes):
        content = node.get_content()
        token_count = count_tokens(content, embedding_model_name)
        items.append(
            {
                "index": idx,
                "content": content,
                "token_count": token_count,
            }
        )

    return {
        "items": items,
        "total_count": len(items),
        "splitter_type": splitter_type,
        "embedding_model": embedding_model_name,
        "created_at": datetime.now(timezone.utc).isoformat(),
    }


class DocumentIndexer:
    """Orchestrates document indexing process."""

    def __init__(
        self,
        storage_backend: BaseStorageBackend,
        embed_model,
        splitter_config: Optional[SplitterConfig] = None,
        file_extension: Optional[str] = None,
        embedding_model_name: str = "",
    ):
        """
        Initialize document indexer.

        Args:
            storage_backend: Storage backend instance
            embed_model: Embedding model
            splitter_config: Optional splitter configuration. If None, defaults to SemanticSplitter
            file_extension: File extension for SmartSplitter
            embedding_model_name: Name of embedding model for token counting
        """
        self.storage_backend = storage_backend
        self.embed_model = embed_model
        self.file_extension = file_extension
        self.embedding_model_name = embedding_model_name
        self.splitter_config = splitter_config
        self.splitter = create_splitter(
            splitter_config,
            embed_model,
            file_extension=file_extension,
            embedding_model_name=embedding_model_name,
        )

    def index_document(
        self, knowledge_id: str, file_path: str, doc_ref: str, **kwargs
    ) -> Dict:
        """
        Index a document from file path (synchronous).

        This method is synchronous because it's called from asyncio.to_thread()
        in DocumentService to avoid event loop conflicts with LlamaIndex.

        Args:
            knowledge_id: Knowledge base ID
            file_path: Path to document file
            doc_ref: Document reference ID
            **kwargs: Additional parameters (e.g., user_id for per_user index strategy)

        Returns:
            Indexing result dict

        Raises:
            Exception: If indexing fails
        """
        # Load document from file
        documents = SimpleDirectoryReader(input_files=[file_path]).load_data()
        source_file = Path(file_path).name

        return self._index_documents(
            documents=documents,
            knowledge_id=knowledge_id,
            doc_ref=doc_ref,
            source_file=source_file,
            **kwargs,
        )

    def index_from_binary(
        self,
        knowledge_id: str,
        binary_data: bytes,
        source_file: str,
        file_extension: str,
        doc_ref: str,
        **kwargs,
    ) -> Dict:
        """
        Index a document from binary data (synchronous).

        This method writes binary data to a temporary file and uses
        SimpleDirectoryReader to parse it, leveraging LlamaIndex's
        built-in document parsing capabilities for various file formats.

        Supports MySQL and external storage (S3/MinIO) binary data.

        Args:
            knowledge_id: Knowledge base ID
            binary_data: Original file binary data from attachment storage
            source_file: Original filename (used for metadata)
            file_extension: File extension (e.g., '.pdf', '.docx')
            doc_ref: Document reference ID
            **kwargs: Additional parameters (e.g., user_id for per_user index strategy)

        Returns:
            Indexing result dict

        Raises:
            Exception: If indexing fails
        """
        # Write binary data to a temporary file for SimpleDirectoryReader
        # This allows LlamaIndex to use its built-in parsers for various formats
        with tempfile.NamedTemporaryFile(
            suffix=file_extension, delete=False
        ) as tmp_file:
            tmp_file.write(binary_data)
            tmp_file_path = tmp_file.name

        try:
            logger.info(
                f"Indexing document from binary: source_file={source_file}, "
                f"extension={file_extension}, size={len(binary_data)} bytes"
            )

            # Load document using SimpleDirectoryReader
            documents = SimpleDirectoryReader(input_files=[tmp_file_path]).load_data()

            # Update metadata with original filename (without extension)
            filename_without_ext = Path(source_file).stem
            for doc in documents:
                doc.metadata["filename"] = filename_without_ext

            return self._index_documents(
                documents=documents,
                knowledge_id=knowledge_id,
                doc_ref=doc_ref,
                source_file=source_file,
                **kwargs,
            )
        finally:
            # Clean up temporary file
            try:
                Path(tmp_file_path).unlink()
            except Exception as e:
                logger.warning(f"Failed to delete temporary file {tmp_file_path}: {e}")

    def _index_documents(
        self,
        documents: List[Document],
        knowledge_id: str,
        doc_ref: str,
        source_file: str,
        **kwargs,
    ) -> Dict:
        """
        Internal method to index documents.

        Args:
            documents: List of LlamaIndex Document objects
            knowledge_id: Knowledge base ID
            doc_ref: Document reference ID
            source_file: Source filename
            **kwargs: Additional parameters

        Returns:
            Indexing result dict (includes chunks_data for all splitter types)
        """
        # Sanitize document metadata to prevent ES mapping conflicts
        # This removes complex nested structures from PPTX/DOCX metadata
        for doc in documents:
            doc.metadata = sanitize_metadata(doc.metadata)

        # Determine splitter type
        splitter_type = "semantic"  # default
        if self.splitter_config:
            splitter_type = getattr(self.splitter_config, "type", "semantic")

        # Split documents into nodes
        chunks_data = None

        if isinstance(self.splitter, SmartSplitter):
            nodes, smart_chunks = self.splitter.split_documents_with_chunks(documents)

            # Validate Markdown chunks if file is .md
            if self.file_extension and self.file_extension.lower() in [".md", "md"]:
                validation_result = validate_markdown_chunks(
                    nodes, self.embedding_model_name
                )
                if not validation_result.is_valid:
                    # Return error, don't index
                    return {
                        "success": False,
                        "error": format_validation_error(validation_result),
                    }

            # Convert to dict for DB storage
            chunks_data = asdict(smart_chunks)
            logger.info(
                f"SmartSplitter created {smart_chunks.total_count} chunks "
                f"for file extension: {self.file_extension}"
            )
        else:
            nodes = self.splitter.split_documents(documents)
            # Build chunks data for all splitter types
            chunks_data = _build_chunks_data(
                nodes, splitter_type, self.embedding_model_name
            )

        # Prepare metadata
        created_at = datetime.now(timezone.utc).isoformat()

        # Delegate to storage backend for metadata addition and indexing
        result = self.storage_backend.index_with_metadata(
            nodes=nodes,
            knowledge_id=knowledge_id,
            doc_ref=doc_ref,
            source_file=source_file,
            created_at=created_at,
            embed_model=self.embed_model,
            **kwargs,
        )

        # Add document info to result
        result.update(
            {
                "success": True,
                "doc_ref": doc_ref,
                "knowledge_id": knowledge_id,
                "source_file": source_file,
                "chunk_count": len(nodes),
                "created_at": created_at,
            }
        )

        # Add chunks data for DB storage (for all splitter types)
        if chunks_data is not None:
            result["chunks_data"] = chunks_data

        return result
