# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Unified document conversion entry point.

Orchestrates: MinerU submission -> ZIP download -> extraction -> S3 upload.
"""

import asyncio
import logging
from dataclasses import dataclass
from typing import List, Optional, Tuple

from knowledge_engine.conversion.formats import (
    KnowledgeFormatPipeline,
    get_knowledge_pipeline,
)
from knowledge_engine.conversion.local_markdown import convert_local_markdown
from knowledge_engine.conversion.mineru_client import (
    SUPPORTED_MIME_TYPES,
    MinerUConfig,
    submit_and_wait,
)
from knowledge_engine.conversion.office_legacy import (
    convert_legacy_office_to_openxml,
    is_legacy_office_extension,
)
from knowledge_engine.conversion.s3_uploader import S3Config, S3Uploader
from knowledge_engine.conversion.zip_extractor import extract_markdown_from_zip

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class ConversionResult:
    """Result of document conversion."""

    markdown_bytes: bytes
    uploaded_images: List[Tuple[str, str]]


def convert_document(
    binary_data: bytes,
    file_extension: str,
    mineru_config: MinerUConfig,
    s3_config: Optional[S3Config] = None,
    s3_base_path: Optional[str] = None,
) -> ConversionResult:
    """
    Convert document to Markdown via MinerU, optionally upload images to S3.

    This is the main entry point for the conversion engine.
    Runs async MinerU API calls in a new event loop (safe for Celery workers).

    Args:
        binary_data: Document binary content
        file_extension: File extension (e.g., ".pdf", "docx")
        mineru_config: MinerU API configuration
        s3_config: Optional S3 configuration for image upload
        s3_base_path: Base path for S3 object keys

    Returns:
        ConversionResult with markdown and uploaded image list

    Raises:
        RuntimeError: If conversion fails
    """
    ext = file_extension.lstrip(".").lower()
    pipeline = get_knowledge_pipeline(ext)

    if pipeline == KnowledgeFormatPipeline.LOCAL_MARKDOWN:
        return ConversionResult(
            markdown_bytes=convert_local_markdown(binary_data, ext),
            uploaded_images=[],
        )

    if pipeline == KnowledgeFormatPipeline.MINERU and is_legacy_office_extension(ext):
        binary_data, ext = convert_legacy_office_to_openxml(binary_data, ext)

    if pipeline != KnowledgeFormatPipeline.MINERU or ext not in SUPPORTED_MIME_TYPES:
        supported = sorted(SUPPORTED_MIME_TYPES)
        raise RuntimeError(
            f"Conversion for '{ext}' not supported. "
            f"Supported: {', '.join(supported)}"
        )

    # Use thread executor if already in a running event loop (e.g., async tests)
    # Celery prefork workers run synchronously, so asyncio.run() is safe there
    try:
        running_loop = asyncio.get_running_loop()
    except RuntimeError:
        running_loop = None

    if running_loop is not None:
        import concurrent.futures

        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
            zip_content = pool.submit(
                asyncio.run, submit_and_wait(binary_data, ext, mineru_config)
            ).result()
    else:
        zip_content = asyncio.run(submit_and_wait(binary_data, ext, mineru_config))

    s3_uploader = S3Uploader(s3_config) if s3_config else None
    result = extract_markdown_from_zip(zip_content, s3_uploader, s3_base_path)

    return ConversionResult(
        markdown_bytes=result.markdown_bytes,
        uploaded_images=result.uploaded_images,
    )
