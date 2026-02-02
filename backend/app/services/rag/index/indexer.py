# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Document indexing orchestration.
"""

import logging
import os
import tempfile
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import TYPE_CHECKING, Any, Dict, List, Optional, Tuple

from llama_index.core import Document, SimpleDirectoryReader
from llama_index.core.ingestion import IngestionPipeline
from llama_index.core.node_parser import MarkdownNodeParser, SentenceSplitter
from llama_index.core.schema import BaseNode

from app.schemas.rag import DoclingPipelineConfig, SplitterConfig
from app.services.rag.splitter import SemanticSplitter, SentenceSplitter as SentenceSplitterClass, SmartSplitter
from app.services.rag.splitter.factory import create_splitter
from app.services.rag.storage.base import BaseStorageBackend
from shared.telemetry.decorators import add_span_event

# Lazy import for DoclingReader to avoid heavy dependency loading at module level
# DoclingReader has large CUDA-related dependencies that may not be installed
if TYPE_CHECKING:
    from llama_index.readers.docling import DoclingReader

# Check if DoclingReader is available (optional dependency)
def _is_docling_available() -> bool:
    """Check if llama-index-readers-docling is installed."""
    try:
        from llama_index.readers.docling import DoclingReader
        return True
    except ImportError:
        return False

DOCLING_AVAILABLE = _is_docling_available()

logger = logging.getLogger(__name__)

# File extensions supported by DoclingReader for intelligent document parsing
# These file types will use DoclingReader + IngestionPipeline for better structure preservation
DOCLING_EXTENSIONS = {".md", ".pdf", ".doc", ".docx", ".ppt", ".pptx", ".xls", ".xlsx"}

# Excel file extensions that require special JSON export format
EXCEL_EXTENSIONS = {".xls", ".xlsx"}


def should_use_docling(file_extension: str) -> bool:
    """
    Determine if DoclingReader should be used for the given file type.

    DoclingReader provides better structure preservation for complex documents
    like PDF, DOCX, PPTX compared to SimpleDirectoryReader.

    Note: Returns False if llama-index-readers-docling is not installed.

    Args:
        file_extension: File extension (e.g., '.pdf', '.docx')

    Returns:
        True if DoclingReader should be used (and is available), False otherwise
    """
    if not DOCLING_AVAILABLE:
        return False
    return file_extension.lower() in DOCLING_EXTENSIONS


def is_excel_file(file_extension: str) -> bool:
    """
    Check if the file is an Excel file requiring JSON export format.

    Excel files use JSON export with special separator for better row-based chunking.

    Args:
        file_extension: File extension (e.g., '.xlsx', '.xls')

    Returns:
        True if the file is an Excel file, False otherwise
    """
    return file_extension.lower() in EXCEL_EXTENSIONS

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


class DocumentIndexer:
    """Orchestrates document indexing process."""

    def __init__(
        self,
        storage_backend: BaseStorageBackend,
        embed_model,
        splitter_config: Optional[SplitterConfig] = None,
        file_extension: Optional[str] = None,
    ):
        """
        Initialize document indexer.

        Args:
            storage_backend: Storage backend instance
            embed_model: Embedding model
            splitter_config: Optional splitter configuration. If None, defaults to SemanticSplitter
            file_extension: Optional file extension for smart splitter
        """
        self.storage_backend = storage_backend
        self.embed_model = embed_model
        self.file_extension = file_extension
        self.splitter = create_splitter(splitter_config, embed_model, file_extension)

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

        This method supports two processing modes based on file type:
        1. Docling mode (for .md, .pdf, .doc, .docx, .ppt, .pptx, .xls, .xlsx):
           - Uses DoclingReader for intelligent document parsing
           - Uses IngestionPipeline for structure-aware chunking
        2. Standard mode (for .txt and other types):
           - Uses SimpleDirectoryReader with existing splitter

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
            Exception: If indexing fails (including DoclingReader processing failure)
        """
        logger.info(
            f"Indexing document from binary: source_file={source_file}, "
            f"extension={file_extension}, size={len(binary_data)} bytes"
        )

        # Determine processing mode based on file extension
        if should_use_docling(file_extension):
            # Use DoclingReader + IngestionPipeline for supported file types
            logger.info(
                f"Using DoclingReader for file type: {file_extension}"
            )
            documents, nodes, docling_config = self._process_with_docling(
                binary_data=binary_data,
                file_extension=file_extension,
                source_file=source_file,
            )
            return self._index_documents(
                documents=documents,
                knowledge_id=knowledge_id,
                doc_ref=doc_ref,
                source_file=source_file,
                pre_split_nodes=nodes,
                docling_config=docling_config,
                **kwargs,
            )
        else:
            # Use standard SimpleDirectoryReader for other file types (.txt, etc.)
            logger.info(
                f"Using SimpleDirectoryReader for file type: {file_extension}"
            )
            return self._process_with_simple_reader(
                binary_data=binary_data,
                file_extension=file_extension,
                source_file=source_file,
                knowledge_id=knowledge_id,
                doc_ref=doc_ref,
                **kwargs,
            )

    def _process_with_docling(
        self,
        binary_data: bytes,
        file_extension: str,
        source_file: str,
    ) -> Tuple[List[Document], List[BaseNode], DoclingPipelineConfig]:
        """
        Process document using DoclingReader and IngestionPipeline.

        DoclingReader provides intelligent document parsing with better
        structure preservation for complex documents.

        Args:
            binary_data: File binary data
            file_extension: File extension (e.g., '.pdf', '.docx')
            source_file: Original filename

        Returns:
            Tuple of (documents, pre-split nodes, docling config)

        Raises:
            Exception: If DoclingReader processing fails
        """
        # Lazy import DoclingReader to avoid loading heavy CUDA dependencies at module level
        from llama_index.readers.docling import DoclingReader

        is_excel = is_excel_file(file_extension)

        # Create temporary file for DoclingReader
        with tempfile.NamedTemporaryFile(
            suffix=file_extension, delete=False
        ) as tmp_file:
            tmp_file.write(binary_data)
            tmp_file_path = tmp_file.name

        try:
            # Configure DoclingReader based on file type
            if is_excel:
                # Excel files use JSON export format for row-based processing
                export_type = DoclingReader.ExportType.JSON
                export_type_str = "json"
                logger.info(f"Configuring DoclingReader with JSON export for Excel file")
            else:
                # General documents use Markdown export format
                export_type = DoclingReader.ExportType.MARKDOWN
                export_type_str = "markdown"
                logger.info(f"Configuring DoclingReader with Markdown export for general document")

            reader = DoclingReader(
                export_type=export_type,
                ocr=False,  # OCR disabled per requirement
                export_images=False,  # Image export disabled per requirement
            )

            # Load documents using DoclingReader
            try:
                documents = reader.load_data(file_path=tmp_file_path)
            except Exception as e:
                # Re-raise with detailed error information
                raise RuntimeError(
                    f"DoclingReader failed to process file: "
                    f"filename={source_file}, "
                    f"extension={file_extension}, "
                    f"error={str(e)}"
                ) from e

            if not documents:
                raise RuntimeError(
                    f"DoclingReader returned no documents: "
                    f"filename={source_file}, extension={file_extension}"
                )

            # Update document metadata with original filename
            filename_without_ext = Path(source_file).stem
            for doc in documents:
                doc.metadata["filename"] = filename_without_ext
                doc.metadata = sanitize_metadata(doc.metadata)

            # Configure IngestionPipeline based on file type
            if is_excel:
                # Excel: Use SentenceSplitter with Chinese semicolon separator
                separator = "；\n"
                pipeline = IngestionPipeline(
                    transformations=[
                        SentenceSplitter(
                            chunk_size=1024,
                            chunk_overlap=50,
                            separator=separator,
                        ),
                    ]
                )
                subtype = "excel_json"
                heading_level_limit = None
                logger.info(
                    f"Configured Excel pipeline with separator='；\\n', "
                    f"chunk_size=1024, chunk_overlap=50"
                )
            else:
                # General documents: Two-stage pipeline (Markdown + Sentence)
                separator = None
                heading_level_limit = 3
                pipeline = IngestionPipeline(
                    transformations=[
                        # Stage 1: Split by Markdown heading structure
                        MarkdownNodeParser(
                            include_metadata=True,
                            include_prev_next_rel=True,
                        ),
                        # Stage 2: Further split large chunks by sentence
                        SentenceSplitter(
                            chunk_size=1024,
                            chunk_overlap=50,
                        ),
                    ]
                )
                subtype = "markdown_pipeline"
                logger.info(
                    f"Configured Markdown pipeline with heading_level_limit=3, "
                    f"chunk_size=1024, chunk_overlap=50"
                )

            # Execute pipeline to get split nodes
            nodes = pipeline.run(documents=documents)
            logger.info(f"DoclingReader pipeline produced {len(nodes)} nodes")

            # Build config for database storage
            docling_config = DoclingPipelineConfig(
                type="docling",
                export_type=export_type_str,
                ocr=False,
                export_images=False,
                heading_level_limit=heading_level_limit,
                chunk_size=1024,
                chunk_overlap=50,
                separator=separator,
                file_extension=file_extension,
            )

            return documents, nodes, docling_config

        finally:
            # Clean up temporary file
            try:
                os.unlink(tmp_file_path)
            except Exception as e:
                logger.warning(f"Failed to delete temporary file {tmp_file_path}: {e}")

    def _process_with_simple_reader(
        self,
        binary_data: bytes,
        file_extension: str,
        source_file: str,
        knowledge_id: str,
        doc_ref: str,
        **kwargs,
    ) -> Dict:
        """
        Process document using SimpleDirectoryReader (original logic).

        This method maintains backward compatibility for file types not
        supported by DoclingReader (e.g., .txt).

        Args:
            binary_data: File binary data
            file_extension: File extension
            source_file: Original filename
            knowledge_id: Knowledge base ID
            doc_ref: Document reference ID
            **kwargs: Additional parameters

        Returns:
            Indexing result dict
        """
        # Write binary data to temporary file
        with tempfile.NamedTemporaryFile(
            suffix=file_extension, delete=False
        ) as tmp_file:
            tmp_file.write(binary_data)
            tmp_file_path = tmp_file.name

        try:
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
        pre_split_nodes: Optional[List[BaseNode]] = None,
        docling_config: Optional[DoclingPipelineConfig] = None,
        **kwargs,
    ) -> Dict:
        """
        Internal method to index documents.

        Args:
            documents: List of LlamaIndex Document objects
            knowledge_id: Knowledge base ID
            doc_ref: Document reference ID
            source_file: Source filename
            pre_split_nodes: Optional pre-split nodes from DoclingReader pipeline.
                            If provided, skips internal splitter processing.
            docling_config: Optional DoclingPipelineConfig for metadata storage
            **kwargs: Additional parameters

        Returns:
            Indexing result dict including chunk metadata for storage
        """
        add_span_event(
            "rag.indexer.documents.received",
            {
                "knowledge_id": knowledge_id,
                "doc_ref": doc_ref,
                "source_file": source_file,
                "document_count": str(len(documents)),
            },
        )

        # Sanitize document metadata to prevent ES mapping conflicts
        # This removes complex nested structures from PPTX/DOCX metadata
        for doc in documents:
            doc.metadata = sanitize_metadata(doc.metadata)

        # Use pre-split nodes if available (from DoclingReader pipeline),
        # otherwise split documents using the configured splitter
        if pre_split_nodes is not None:
            nodes = pre_split_nodes
            splitter_type_name = "DoclingPipeline"
            logger.info(
                f"Using pre-split nodes from DoclingReader: {len(nodes)} nodes"
            )
        else:
            nodes = self.splitter.split_documents(documents)
            splitter_type_name = type(self.splitter).__name__

        add_span_event(
            "rag.indexer.documents.split",
            {
                "knowledge_id": knowledge_id,
                "doc_ref": doc_ref,
                "node_count": str(len(nodes)),
                "splitter_type": splitter_type_name,
            },
        )

        # Build chunk metadata for storage in database
        chunks_data = self._build_chunks_metadata(nodes, docling_config=docling_config)

        # Prepare metadata
        created_at = datetime.now(timezone.utc).isoformat()

        # Delegate to storage backend for metadata addition and indexing
        add_span_event(
            "rag.indexer.vector_store.indexing_started",
            {
                "knowledge_id": knowledge_id,
                "doc_ref": doc_ref,
                "node_count": str(len(nodes)),
                "storage_backend": type(self.storage_backend).__name__,
            },
        )
        result = self.storage_backend.index_with_metadata(
            nodes=nodes,
            knowledge_id=knowledge_id,
            doc_ref=doc_ref,
            source_file=source_file,
            created_at=created_at,
            embed_model=self.embed_model,
            **kwargs,
        )
        add_span_event(
            "rag.indexer.vector_store.indexing_completed",
            {
                "knowledge_id": knowledge_id,
                "doc_ref": doc_ref,
                "indexed_count": str(result.get("indexed_count", 0)),
                "index_name": result.get("index_name", "unknown"),
                "status": result.get("status", "unknown"),
            },
        )

        # Add document info to result
        result.update(
            {
                "doc_ref": doc_ref,
                "knowledge_id": knowledge_id,
                "source_file": source_file,
                "chunk_count": len(nodes),
                "created_at": created_at,
                "chunks_data": chunks_data,  # Include chunk metadata for DB storage
            }
        )

        # Include splitter config for database storage if using Docling
        if docling_config is not None:
            result["splitter_config"] = docling_config.model_dump()

        return result

    def _build_chunks_metadata(
        self,
        nodes: List,
        docling_config: Optional[DoclingPipelineConfig] = None,
    ) -> Dict[str, Any]:
        """
        Build chunk metadata from nodes for storage in database.

        Args:
            nodes: List of nodes from splitter
            docling_config: Optional DoclingPipelineConfig if using Docling processing

        Returns:
            Dictionary with chunk metadata suitable for JSON storage
        """
        items = []
        current_position = 0

        for idx, node in enumerate(nodes):
            text = node.text if hasattr(node, "text") else str(node)
            text_length = len(text)

            # Estimate token count (roughly 4 characters per token)
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

        # Determine splitter type info based on processing mode
        if docling_config is not None:
            # Docling processing mode
            splitter_type = "docling"
            # Determine subtype based on export format
            if docling_config.export_type == "json":
                splitter_subtype = "excel_json"
            else:
                splitter_subtype = "markdown_pipeline"
        elif isinstance(self.splitter, SmartSplitter):
            splitter_type = "smart"
            splitter_subtype = self.splitter._get_subtype()
        elif isinstance(self.splitter, SentenceSplitterClass):
            splitter_type = "sentence"
            splitter_subtype = None
        else:
            splitter_type = "semantic"  # default
            splitter_subtype = None

        return {
            "items": items,
            "total_count": len(items),
            "splitter_type": splitter_type,
            "splitter_subtype": splitter_subtype,
            "created_at": datetime.now(timezone.utc).isoformat(),
        }
