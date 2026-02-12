# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Factory for creating document processing pipelines.

This factory determines the appropriate pipeline based on file type
and available services (Pandoc, LlamaIndex), with automatic
fallback when services are unavailable.

Pipeline Selection Strategy:
1. DOC/DOCX/PPT/PPTX:
   -> PandocPipeline (with Pandoc availability check)
2. PDF:
   -> LlamaIndexPipeline (default)
3. Other files (TXT, MD, etc.):
   -> LlamaIndexPipeline
"""

import logging
from typing import Optional

from app.services.rag.pipeline.base import BaseDocumentPipeline
from app.services.rag.pipeline.llamaindex import LlamaIndexPipeline
from app.services.rag.pipeline.pandoc import (
    PandocNotFoundError,
    PandocPipeline,
)

logger = logging.getLogger(__name__)

# File extensions that require conversion (not natively supported by LlamaIndex well)
OFFICE_EXTENSIONS = {".doc", ".docx", ".ppt", ".pptx"}

# PDF extensions
PDF_EXTENSIONS = {".pdf"}

# Extensions that LlamaIndex handles natively
LLAMAINDEX_EXTENSIONS = {".txt", ".md", ".json", ".csv"}


def should_use_pipeline(file_extension: str) -> bool:
    """
    Check if the given file extension should use the new pipeline architecture.

    The pipeline architecture is used for:
    - Office documents (DOC, DOCX, PPT, PPTX) - always use pipeline

    Args:
        file_extension: File extension to check (e.g., '.docx')

    Returns:
        True if pipeline should be used for this file type
    """
    ext = file_extension.lower()

    # Office documents always use pipeline (Pandoc)
    if ext in OFFICE_EXTENSIONS:
        return True

    return False


def create_pipeline(
    file_extension: str,
    chunk_size: int = BaseDocumentPipeline.DEFAULT_CHUNK_SIZE,
    chunk_overlap: int = BaseDocumentPipeline.DEFAULT_CHUNK_OVERLAP,
) -> BaseDocumentPipeline:
    """
    Create the appropriate document pipeline for the given file type.

    Pipeline selection logic:
    1. DOC/DOCX/PPT/PPTX:
       - Use Pandoc
    2. PDF:
       - Use LlamaIndex
    3. Other files:
       - Use LlamaIndex

    Args:
        file_extension: File extension (e.g., '.docx', '.pdf')
        chunk_size: Maximum chunk size in characters
        chunk_overlap: Number of characters to overlap between chunks

    Returns:
        Appropriate pipeline instance

    Raises:
        ValueError: If no suitable pipeline can be created
    """
    ext = file_extension.lower()

    logger.info(f"Creating pipeline for extension: {ext}")

    # Handle Office documents (DOC, DOCX, PPT, PPTX)
    if ext in OFFICE_EXTENSIONS:
        return _create_office_pipeline(ext, chunk_size, chunk_overlap)

    # Handle PDF files
    if ext in PDF_EXTENSIONS:
        return _create_pdf_pipeline(ext, chunk_size, chunk_overlap)

    # Default to LlamaIndex for other file types
    return LlamaIndexPipeline(
        file_extension=ext,
        chunk_size=chunk_size,
        chunk_overlap=chunk_overlap,
    )


def _create_office_pipeline(
    file_extension: str,
    chunk_size: int,
    chunk_overlap: int,
) -> BaseDocumentPipeline:
    """
    Create pipeline for Office documents.

    Uses PandocPipeline (if Pandoc is installed).

    Args:
        file_extension: File extension
        chunk_size: Maximum chunk size
        chunk_overlap: Overlap between chunks

    Returns:
        Pipeline instance

    Raises:
        ValueError: If Pandoc is not available
    """
    # Use Pandoc
    pandoc_pipeline = _try_create_pandoc_pipeline(chunk_size, chunk_overlap)
    if pandoc_pipeline:
        logger.info(f"Using PandocPipeline for {file_extension}")
        return pandoc_pipeline

    # No suitable pipeline available
    raise ValueError(
        f"Cannot process {file_extension} files: "
        "Pandoc is not installed. "
        "Please install Pandoc."
    )


def _create_pdf_pipeline(
    file_extension: str,
    chunk_size: int,
    chunk_overlap: int,
) -> BaseDocumentPipeline:
    """
    Create pipeline for PDF files.

    Uses LlamaIndexPipeline (default).

    Args:
        file_extension: File extension
        chunk_size: Maximum chunk size
        chunk_overlap: Overlap between chunks

    Returns:
        Pipeline instance
    """
    # Use LlamaIndex
    logger.info(f"Using LlamaIndexPipeline for {file_extension}")
    return LlamaIndexPipeline(
        file_extension=file_extension,
        chunk_size=chunk_size,
        chunk_overlap=chunk_overlap,
    )


def _try_create_pandoc_pipeline(
    chunk_size: int,
    chunk_overlap: int,
) -> Optional[PandocPipeline]:
    """
    Try to create a PandocPipeline.

    Checks if Pandoc is installed on the system.
    Returns None if Pandoc is not available.

    Args:
        chunk_size: Maximum chunk size
        chunk_overlap: Overlap between chunks

    Returns:
        PandocPipeline instance or None
    """
    if not PandocPipeline.is_pandoc_available():
        logger.debug("Pandoc is not installed")
        return None

    try:
        return PandocPipeline(
            chunk_size=chunk_size,
            chunk_overlap=chunk_overlap,
        )
    except PandocNotFoundError as e:
        logger.warning(f"Pandoc not available: {e}")
        return None
    except Exception as e:
        logger.warning(f"Failed to create PandocPipeline: {e}")
        return None


def get_pipeline_info(file_extension: str) -> dict:
    """
    Get information about which pipeline would be used for a file type.

    Useful for debugging and API responses.

    Args:
        file_extension: File extension to check

    Returns:
        Dictionary with pipeline selection details
    """
    ext = file_extension.lower()

    info = {
        "file_extension": ext,
        "pandoc_available": PandocPipeline.is_pandoc_available(),
        "requires_pipeline": should_use_pipeline(ext),
        "recommended_pipeline": None,
    }

    if ext in OFFICE_EXTENSIONS:
        if PandocPipeline.is_pandoc_available():
            info["recommended_pipeline"] = "PandocPipeline"
        else:
            info["recommended_pipeline"] = "None (install Pandoc)"

    elif ext in PDF_EXTENSIONS:
        info["recommended_pipeline"] = "LlamaIndexPipeline"

    else:
        info["recommended_pipeline"] = "LlamaIndexPipeline"

    return info
