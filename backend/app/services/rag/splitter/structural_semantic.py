# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Enhanced Structural Semantic Splitter for document chunking.

This splitter implements an eight-phase document processing pipeline:

1. Text Extraction - Extract text, detect and skip non-text content
2. Structure Recognition - Identify heading/paragraph/code/table/flow/list/qa
3. Noise Filtering - Remove TOC, headers/footers, duplicates
4. Structural Chunking - Split by semantic closure
5. API Structure Detection (Phase 5.5) - Detect API documentation patterns
6. LLM Chunking Gate - Decide LLM vs rule-based chunking strategy
6.5. Semantic Chunk Validation - Validate and auto-correct chunks
7. Content Cleaning - Normalize and clean content by type
8. Token Splitting - Respect atomic flag and overflow strategies

The pipeline produces semantically coherent chunks optimized for RAG retrieval.
"""

import logging
from dataclasses import asdict
from typing import Any, Dict, List, Optional, Tuple

import tiktoken
from llama_index.core import Document
from llama_index.core.schema import BaseNode, TextNode

from .chunkers import (
    APIRuleBasedChunker,
    LLMChunkingGate,
    SemanticTokenSplitter,
    StructuralChunker,
    TokenSplitter,
)
from .cleaners import ContentCleaner
from .extractors import ExtractorFactory
from .filters import NoiseFilter
from .models import ChunkItem, DocumentChunks, SemanticChunk, SkippedElementType
from .recognizers import APIStructureDetector, StructureRecognizer
from .validators import SemanticChunkValidator

logger = logging.getLogger(__name__)

# Token limits
MAX_CHUNK_TOKENS = 600
MIN_CHUNK_TOKENS = 100
OVERLAP_TOKENS = 80

# Supported file extensions for structural semantic splitting
SUPPORTED_EXTENSIONS = {".pdf", ".docx", ".doc", ".md", ".txt"}


class StructuralSemanticSplitter:
    """
    Enhanced Structural Semantic Document Splitter.

    Eight-phase pipeline:
    1. Text Extraction - Extract text, detect and skip non-text content
    2. Structure Recognition - Identify heading/paragraph/code/table/flow/list/qa
    3. Noise Filtering - Remove TOC, headers/footers, duplicates
    4. Structural Chunking - Split by semantic closure
    5. API Structure Detection (Phase 5.5) - Detect API documentation patterns
    6. LLM Chunking Gate - Decide LLM vs rule-based chunking strategy
    6.5. Semantic Chunk Validation - Validate and auto-correct chunks
    7. Content Cleaning - Normalize and clean content by type
    8. Token Splitting - Respect atomic flag and overflow strategies
    """

    def __init__(
        self,
        llm_client: Optional[Any] = None,  # Kept for backward compatibility, not used
        min_chunk_tokens: int = MIN_CHUNK_TOKENS,
        max_chunk_tokens: int = MAX_CHUNK_TOKENS,
        overlap_tokens: int = OVERLAP_TOKENS,
        enable_api_detection: bool = True,
        enable_llm_gate: bool = True,
        enable_validation: bool = True,
    ):
        """
        Initialize structural semantic splitter.

        Args:
            llm_client: Deprecated, kept for backward compatibility
            min_chunk_tokens: Minimum tokens per chunk (default: 100)
            max_chunk_tokens: Maximum tokens per chunk (default: 600)
            overlap_tokens: Overlap tokens for forced splits (default: 80)
            enable_api_detection: Whether to enable API structure detection (default: True)
            enable_llm_gate: Whether to enable LLM chunking gate (default: True)
            enable_validation: Whether to enable chunk validation (default: True)
        """
        self.min_chunk_tokens = min_chunk_tokens
        self.max_chunk_tokens = max_chunk_tokens
        self.overlap_tokens = overlap_tokens
        self.enable_api_detection = enable_api_detection
        self.enable_llm_gate = enable_llm_gate
        self.enable_validation = enable_validation

        # Initialize tokenizer
        try:
            self.tokenizer = tiktoken.get_encoding("cl100k_base")
        except Exception:
            self.tokenizer = tiktoken.get_encoding("gpt2")

        # Initialize pipeline components
        self._init_pipeline_components()

    def _init_pipeline_components(self) -> None:
        """Initialize all pipeline components."""
        self.extractor_factory = ExtractorFactory()
        self.recognizer = StructureRecognizer()
        self.noise_filter = NoiseFilter()
        self.structural_chunker = StructuralChunker()
        self.api_detector = APIStructureDetector()
        self.api_chunker = APIRuleBasedChunker()

        # Phase 6: LLM Chunking Gate
        self.llm_gate = LLMChunkingGate()

        # Phase 6.5: Semantic Chunk Validator
        self.chunk_validator = SemanticChunkValidator()

        # Phase 7: Content Cleaner
        self.content_cleaner = ContentCleaner()

        # Phase 8: Semantic Token Splitter (replaces old TokenSplitter)
        self.semantic_token_splitter = SemanticTokenSplitter(
            min_tokens=self.min_chunk_tokens,
            max_tokens=self.max_chunk_tokens,
            overlap_tokens=self.overlap_tokens,
            tokenizer=self.tokenizer,
        )

        # Keep old token splitter for backward compatibility
        self.token_splitter = TokenSplitter(
            min_tokens=self.min_chunk_tokens,
            max_tokens=self.max_chunk_tokens,
            overlap_tokens=self.overlap_tokens,
            tokenizer=self.tokenizer,
        )

    def count_tokens(self, text: str) -> int:
        """Count tokens in text using tiktoken."""
        return len(self.tokenizer.encode(text))

    def split_documents(self, documents: List[Document]) -> List[BaseNode]:
        """
        Main entry point - returns LlamaIndex nodes.

        This is a synchronous method compatible with the existing pipeline.

        Args:
            documents: List of LlamaIndex Document objects

        Returns:
            List of TextNode objects
        """
        nodes, _ = self.split_documents_with_chunks(documents)
        return nodes

    def split_documents_with_chunks(
        self, documents: List[Document]
    ) -> Tuple[List[BaseNode], DocumentChunks]:
        """
        Split documents through the full pipeline.

        Returns both nodes (for vector storage) and DocumentChunks (for DB storage).
        DocumentChunks can be converted to JSON via asdict() for database storage.

        Args:
            documents: List of LlamaIndex Document objects

        Returns:
            Tuple of (List[TextNode], DocumentChunks)
        """
        all_nodes: List[BaseNode] = []
        all_chunk_items: List[ChunkItem] = []
        all_skipped_types: set = set()
        all_skipped_detail: List[Dict[str, Any]] = []
        has_non_text = False

        processing_stats = {
            "total_documents": len(documents),
            "total_images_skipped": 0,
            "total_drawings_skipped": 0,
            "total_charts_skipped": 0,
            "total_other_skipped": 0,
        }

        chunk_index = 0
        position = 0

        for doc in documents:
            text = doc.text or ""
            if not text.strip():
                continue

            # Get file info from metadata
            filename = doc.metadata.get("filename", "unknown")
            file_type = doc.metadata.get("file_type", "")

            # Infer file type from filename if not provided
            if not file_type and filename:
                import os

                _, ext = os.path.splitext(filename)
                file_type = ext.lstrip(".") if ext else "txt"

            # Process through the eight-phase pipeline
            try:
                chunk_items, skipped_elements = self._process_document(
                    text=text,
                    filename=filename,
                    file_type=file_type,
                    doc_metadata=doc.metadata,
                    start_chunk_index=chunk_index,
                    start_position=position,
                )

                # Record skipped elements
                if skipped_elements:
                    has_non_text = True
                    for elem in skipped_elements:
                        elem_type = elem.get("type", "")
                        if isinstance(elem_type, SkippedElementType):
                            elem_type = elem_type.value
                        all_skipped_types.add(elem_type)
                        all_skipped_detail.append(elem)

                        # Update stats
                        if elem_type == "image":
                            processing_stats["total_images_skipped"] += 1
                        elif elem_type == "drawing":
                            processing_stats["total_drawings_skipped"] += 1
                        elif elem_type == "chart":
                            processing_stats["total_charts_skipped"] += 1
                        else:
                            processing_stats["total_other_skipped"] += 1

                # Create nodes and update indices
                for chunk_item in chunk_items:
                    node = TextNode(
                        text=chunk_item.content,
                        metadata={
                            **doc.metadata,
                            "chunk_index": chunk_item.chunk_index,
                            "start_position": chunk_item.start_position,
                            "end_position": chunk_item.end_position,
                            "token_count": chunk_item.token_count,
                            "forced_split": chunk_item.forced_split,
                            "chunk_type": chunk_item.chunk_type,
                            "title_path": chunk_item.title_path,
                        },
                    )
                    all_nodes.append(node)
                    all_chunk_items.append(chunk_item)

                    # Update counters
                    chunk_index = chunk_item.chunk_index + 1
                    position = chunk_item.end_position

            except Exception as e:
                logger.error(f"Error processing document '{filename}': {e}")
                # Fallback: create single chunk from raw text
                fallback_chunk = self._create_fallback_chunk(
                    text=text,
                    doc_metadata=doc.metadata,
                    chunk_index=chunk_index,
                    position=position,
                )
                all_chunk_items.append(fallback_chunk)

                node = TextNode(
                    text=fallback_chunk.content,
                    metadata={
                        **doc.metadata,
                        "chunk_index": fallback_chunk.chunk_index,
                        "start_position": fallback_chunk.start_position,
                        "end_position": fallback_chunk.end_position,
                        "token_count": fallback_chunk.token_count,
                        "forced_split": fallback_chunk.forced_split,
                    },
                )
                all_nodes.append(node)

                chunk_index += 1
                position += len(text)

        # Build DocumentChunks (compatible with existing schema)
        document_chunks = DocumentChunks(
            chunks=all_chunk_items,
            total_chunks=len(all_chunk_items),
            overlap_tokens=self.overlap_tokens,
            has_non_text_content=has_non_text,
            skipped_elements=list(all_skipped_types),  # list[str] for compatibility
            skipped_elements_detail=all_skipped_detail,
            processing_stats=processing_stats,
        )

        logger.info(
            f"StructuralSemanticSplitter created {len(all_chunk_items)} chunks, "
            f"has_non_text_content={has_non_text}"
        )

        return all_nodes, document_chunks

    def _process_document(
        self,
        text: str,
        filename: str,
        file_type: str,
        doc_metadata: Dict[str, Any],
        start_chunk_index: int,
        start_position: int,
    ) -> Tuple[List[ChunkItem], List[Dict[str, Any]]]:
        """
        Process a single document through the eight-phase pipeline.

        Args:
            text: Document text content
            filename: Original filename
            file_type: File type/extension
            doc_metadata: Document metadata
            start_chunk_index: Starting chunk index
            start_position: Starting position in document

        Returns:
            Tuple of (List[ChunkItem], List[skipped_element_dicts])
        """
        # Phase 1: Text Extraction
        extractor = self.extractor_factory.get_extractor(file_type)
        raw_text, line_metadata, skipped_elements = extractor.extract_from_text(
            text, filename
        )

        if skipped_elements:
            logger.info(
                f"Document '{filename}' has {len(skipped_elements)} non-text elements skipped"
            )

        # Phase 2: Structure Recognition
        source_info = {
            "filename": filename,
            "file_type": file_type,
        }
        doc_ir = self.recognizer.recognize(raw_text, line_metadata, source_info)

        # Phase 3: Noise Filtering
        filtered_ir = self.noise_filter.filter(doc_ir)

        # Phase 4: Structural Chunking
        structural_chunks = self.structural_chunker.chunk(filtered_ir)

        # Phase 5.5: API Structure Detection (optional)
        api_info = None
        api_chunks = []
        semantic_chunks: List[SemanticChunk] = []

        if self.enable_api_detection:
            api_info = self.api_detector.detect(filtered_ir.blocks)
            if api_info.is_api_doc:
                logger.info(
                    f"[Phase5.5] Document '{filename}' detected as API doc "
                    f"with {api_info.total_endpoints} endpoints"
                )
                # Generate API-specific chunks
                semantic_chunks = self.api_chunker.chunk(
                    blocks=filtered_ir.blocks,
                    api_info=api_info,
                    heading_context=[],
                )
                api_chunks = self.api_chunker.convert_to_chunk_dicts(semantic_chunks)

        # Phase 6: LLM Chunking Gate
        use_llm_chunking = False
        gate_reason = "disabled"

        if self.enable_llm_gate and api_info:
            use_llm_chunking, gate_reason = self.llm_gate.should_use_llm(
                filtered_ir.blocks, api_info
            )
            logger.info(
                f"[Phase6] LLM Chunking Gate: use_llm={use_llm_chunking}, reason='{gate_reason}'"
            )

        # Combine structural chunks with API chunks
        # API chunks take precedence for API sections, structural for others
        if api_chunks:
            # Get block indices covered by API chunks
            api_covered_blocks = set()
            for chunk in api_chunks:
                api_covered_blocks.update(chunk.get("source_blocks", []))

            # Filter structural chunks to only include non-API content
            filtered_structural = []
            for chunk in structural_chunks:
                # Keep chunks that don't overlap with API content
                chunk_blocks = set(chunk.get("metadata", {}).get("block_indices", []))
                if not chunk_blocks or not chunk_blocks.intersection(api_covered_blocks):
                    filtered_structural.append(chunk)

            # Merge: API chunks first, then remaining structural chunks
            combined_chunks = api_chunks + filtered_structural
        else:
            combined_chunks = structural_chunks

        # Phase 6.5: Semantic Chunk Validation (optional)
        validated_semantic_chunks = semantic_chunks
        if self.enable_validation and semantic_chunks:
            # Get current heading context from doc_ir
            heading_context = self._extract_heading_context(filtered_ir.blocks)

            validation_result = self.chunk_validator.validate(
                chunks=semantic_chunks,
                blocks=filtered_ir.blocks,
                heading_context=heading_context,
            )

            if validation_result.fixed_chunks:
                validated_semantic_chunks = validation_result.fixed_chunks
                logger.info(
                    f"[Phase6.5] Validation fixed {len(semantic_chunks)} -> "
                    f"{len(validated_semantic_chunks)} chunks"
                )

                # Update combined_chunks with validated semantic chunks
                validated_chunk_dicts = self.api_chunker.convert_to_chunk_dicts(
                    validated_semantic_chunks
                )
                # Re-combine with structural chunks
                combined_chunks = validated_chunk_dicts + [
                    c for c in combined_chunks if c not in api_chunks
                ]

        # Phase 7: Content Cleaning
        cleaned_chunks = self.content_cleaner.clean(combined_chunks)

        # Phase 8: Token Splitting with overflow strategies
        if validated_semantic_chunks:
            # Use SemanticTokenSplitter for semantic chunks (respects atomic + overflow)
            split_semantic_chunks, split_stats = self.semantic_token_splitter.split_if_needed(
                validated_semantic_chunks
            )
            logger.info(
                f"[Phase8] Semantic token split: {split_stats['total_input']} -> "
                f"{len(split_semantic_chunks)} chunks, "
                f"split={split_stats['split_count']}, atomic_kept={split_stats['atomic_kept']}"
            )
            # Convert back to chunk dicts
            final_chunks = self.api_chunker.convert_to_chunk_dicts(split_semantic_chunks)
        else:
            # Use regular token splitter for non-semantic chunks
            final_chunks = self.token_splitter.split(cleaned_chunks)

        # Convert to ChunkItem objects
        chunk_items: List[ChunkItem] = []
        position = start_position
        chunk_index = start_chunk_index

        for chunk in final_chunks:
            content = chunk.get("content", "")
            token_count = self.count_tokens(content)

            chunk_item = ChunkItem(
                chunk_index=chunk_index,
                content=content,
                token_count=token_count,
                start_position=position,
                end_position=position + len(content),
                forced_split=chunk.get("forced_split", False),
                chunk_type=chunk.get("chunk_type"),
                title_path=chunk.get("title_path"),
                page_number=chunk.get("page_number"),
                line_start=chunk.get("line_start"),
                line_end=chunk.get("line_end"),
                is_merged=chunk.get("is_merged", False),
                is_split=chunk.get("is_split", False),
                split_index=chunk.get("split_index"),
                notes=chunk.get("notes"),
                metadata=chunk.get("metadata", {}),
            )
            chunk_items.append(chunk_item)

            chunk_index += 1
            position += len(content)

        return chunk_items, skipped_elements

    def _extract_heading_context(self, blocks: List[Any]) -> List[str]:
        """Extract heading context from blocks."""
        from .models.ir import BlockType

        heading_context = []
        for block in blocks:
            if block.type == BlockType.HEADING:
                level = block.level or 1
                text = block.content.strip().lstrip("#").strip()
                # Adjust heading path based on level
                while len(heading_context) >= level:
                    heading_context.pop()
                heading_context.append(text)
        return heading_context

    def _create_fallback_chunk(
        self,
        text: str,
        doc_metadata: Dict[str, Any],
        chunk_index: int,
        position: int,
    ) -> ChunkItem:
        """Create a fallback chunk when pipeline processing fails."""
        token_count = self.count_tokens(text)

        return ChunkItem(
            chunk_index=chunk_index,
            content=text,
            token_count=token_count,
            start_position=position,
            end_position=position + len(text),
            forced_split=False,
            chunk_type="paragraph",
            notes="Fallback chunk due to processing error",
        )

    # ===== Backward Compatibility Methods =====

    def detect_non_text_content(self, text: str) -> Tuple[bool, List[str]]:
        """
        Detect non-text content (images, tables) in text.

        Kept for backward compatibility.

        Returns:
            Tuple of (has_non_text, list of element types detected)
        """
        extractor = self.extractor_factory.get_extractor("txt")
        has_non_text, skipped_elements = extractor.detect_non_text_elements(text)

        detected_types = []
        for elem in skipped_elements:
            elem_type = elem.get("type", "")
            if isinstance(elem_type, SkippedElementType):
                elem_type = elem_type.value

            # Map to legacy types
            if elem_type == "image":
                if "images" not in detected_types:
                    detected_types.append("images")
            elif elem_type in {"chart", "drawing", "equation"}:
                if "tables" not in detected_types:
                    detected_types.append("tables")

        return has_non_text, detected_types

    def remove_non_text_content(self, text: str) -> str:
        """
        Remove non-text content from text.

        Kept for backward compatibility.
        """
        extractor = self.extractor_factory.get_extractor("txt")
        return extractor.remove_non_text_elements(text)

    def get_config(self) -> dict:
        """Get splitter configuration."""
        return {
            "type": "structural_semantic",
            "min_chunk_tokens": self.min_chunk_tokens,
            "max_chunk_tokens": self.max_chunk_tokens,
            "overlap_tokens": self.overlap_tokens,
            "enable_api_detection": self.enable_api_detection,
            "enable_llm_gate": self.enable_llm_gate,
            "enable_validation": self.enable_validation,
        }


def is_structural_semantic_supported(file_extension: str) -> bool:
    """Check if file extension supports structural semantic splitting."""
    ext = file_extension.lower()
    if not ext.startswith("."):
        ext = f".{ext}"
    return ext in SUPPORTED_EXTENSIONS
