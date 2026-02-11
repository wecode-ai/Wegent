# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Factory for creating document processing pipelines.

This factory determines the appropriate pipeline based on file type
and available services (Docling, Pandoc, LlamaIndex), with automatic
fallback when services are unavailable.

Pipeline Selection Strategy:
1. DOC/DOCX/PPT/PPTX:
   - If Docling is configured and available -> DoclingPipeline
   - Else -> PandocPipeline (with Pandoc availability check)
2. PDF:
   - If Docling is configured and available -> DoclingPipeline
   - Else -> LlamaIndexPipeline (default)
3. Other files (TXT, MD, etc.):
   -> LlamaIndexPipeline
"""

import logging
from typing import Optional

from app.core.config import settings
from app.services.rag.pipeline.base import BaseDocumentPipeline
from app.services.rag.pipeline.docling import DoclingPipeline, DoclingServiceError
from app.services.rag.pipeline.llamaindex import LlamaIndexPipeline
from app.services.rag.pipeline.pandoc import (
    PandocNotFoundError,
    PandocPipeline,
)

logger = logging.getLogger(__name__)

# File extensions that require conversion (not natively supported by LlamaIndex well)
OFFICE_EXTENSIONS = {".doc", ".docx", ".ppt", ".pptx"}

# PDF can benefit from Docling but LlamaIndex handles it well too
PDF_EXTENSIONS = {".pdf"}

# Extensions that LlamaIndex handles natively
LLAMAINDEX_EXTENSIONS = {".txt", ".md", ".json", ".csv"}


def should_use_pipeline(file_extension: str) -> bool:
    """
    Check if the given file extension should use the new pipeline architecture.

    The pipeline architecture is used for:
    - Office documents (DOC, DOCX, PPT, PPTX) - always use pipeline
    - PDF files when Docling is configured

    Args:
        file_extension: File extension to check (e.g., '.docx')

    Returns:
        True if pipeline should be used for this file type
    """
    ext = file_extension.lower()

    # Office documents always use pipeline (Docling or Pandoc)
    if ext in OFFICE_EXTENSIONS:
        return True

    # PDF uses pipeline only if Docling is configured
    if ext in PDF_EXTENSIONS and _is_docling_configured():
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
       - Try Docling first (if configured)
       - Fall back to Pandoc
    2. PDF:
       - Try Docling (if configured)
       - Fall back to LlamaIndex
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

    Priority:
    1. DoclingPipeline (if configured and available)
    2. PandocPipeline (if Pandoc is installed)

    Args:
        file_extension: File extension
        chunk_size: Maximum chunk size
        chunk_overlap: Overlap between chunks

    Returns:
        Pipeline instance

    Raises:
        ValueError: If neither Docling nor Pandoc is available
    """
    # Try Docling first
    docling_pipeline = _try_create_docling_pipeline(chunk_size, chunk_overlap)
    if docling_pipeline:
        logger.info(f"Using DoclingPipeline for {file_extension}")
        return docling_pipeline

    # Fall back to Pandoc
    pandoc_pipeline = _try_create_pandoc_pipeline(chunk_size, chunk_overlap)
    if pandoc_pipeline:
        logger.info(f"Using PandocPipeline for {file_extension}")
        return pandoc_pipeline

    # No suitable pipeline available
    raise ValueError(
        f"Cannot process {file_extension} files: "
        "Docling is not configured and Pandoc is not installed. "
        "Please configure DOCLING_URL or install Pandoc."
    )


def _create_pdf_pipeline(
    file_extension: str,
    chunk_size: int,
    chunk_overlap: int,
) -> BaseDocumentPipeline:
    """
    Create pipeline for PDF files.

    Priority:
    1. DoclingPipeline (if configured and available)
    2. LlamaIndexPipeline (default fallback)

    Args:
        file_extension: File extension
        chunk_size: Maximum chunk size
        chunk_overlap: Overlap between chunks

    Returns:
        Pipeline instance
    """
    # Try Docling first
    docling_pipeline = _try_create_docling_pipeline(chunk_size, chunk_overlap)
    if docling_pipeline:
        logger.info(f"Using DoclingPipeline for {file_extension}")
        return docling_pipeline

    # Fall back to LlamaIndex
    logger.info(f"Using LlamaIndexPipeline for {file_extension}")
    return LlamaIndexPipeline(
        file_extension=file_extension,
        chunk_size=chunk_size,
        chunk_overlap=chunk_overlap,
    )


def _is_docling_configured() -> bool:
    """
    Check if Docling is configured in settings.

    Returns:
        True if DOCLING_URL is set
    """
    docling_url = getattr(settings, "DOCLING_URL", None)
    return bool(docling_url and docling_url.strip())


def _try_create_docling_pipeline(
    chunk_size: int,
    chunk_overlap: int,
) -> Optional[DoclingPipeline]:
    """
    Try to create a DoclingPipeline.

    Checks if Docling is configured and the service is available.
    Returns None if Docling cannot be used.

    Args:
        chunk_size: Maximum chunk size
        chunk_overlap: Overlap between chunks

    Returns:
        DoclingPipeline instance or None
    """
    if not _is_docling_configured():
        logger.debug("Docling not configured (DOCLING_URL not set)")
        return None

    docling_url = settings.DOCLING_URL
    docling_timeout = getattr(settings, "DOCLING_TIMEOUT", 120)

    # Check if service is available
    if not DoclingPipeline.is_service_available(docling_url):
        logger.warning(
            f"Docling service at {docling_url} is not available, "
            "falling back to alternative pipeline"
        )
        return None

    try:
        return DoclingPipeline(
            docling_url=docling_url,
            chunk_size=chunk_size,
            chunk_overlap=chunk_overlap,
            timeout=docling_timeout,
        )
    except Exception as e:
        logger.warning(f"Failed to create DoclingPipeline: {e}")
        return None


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
        "docling_configured": _is_docling_configured(),
        "docling_url": (
            getattr(settings, "DOCLING_URL", None) if _is_docling_configured() else None
        ),
        "pandoc_available": PandocPipeline.is_pandoc_available(),
        "requires_pipeline": should_use_pipeline(ext),
        "recommended_pipeline": None,
    }

    if ext in OFFICE_EXTENSIONS:
        if _is_docling_configured():
            docling_url = settings.DOCLING_URL
            if DoclingPipeline.is_service_available(docling_url):
                info["recommended_pipeline"] = "DoclingPipeline"
            elif PandocPipeline.is_pandoc_available():
                info["recommended_pipeline"] = "PandocPipeline (Docling unavailable)"
        elif PandocPipeline.is_pandoc_available():
            info["recommended_pipeline"] = "PandocPipeline"
        else:
            info["recommended_pipeline"] = "None (install Pandoc or configure Docling)"

    elif ext in PDF_EXTENSIONS:
        if _is_docling_configured():
            docling_url = settings.DOCLING_URL
            if DoclingPipeline.is_service_available(docling_url):
                info["recommended_pipeline"] = "DoclingPipeline"
            else:
                info["recommended_pipeline"] = (
                    "LlamaIndexPipeline (Docling unavailable)"
                )
        else:
            info["recommended_pipeline"] = "LlamaIndexPipeline"

    else:
        info["recommended_pipeline"] = "LlamaIndexPipeline"

    return info
