# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Celery async tasks for document parsing.

Provides asynchronous document parsing for large files.
"""

import logging
import time
import uuid
from datetime import datetime
from typing import Optional

logger = logging.getLogger(__name__)


def parse_document_task(
    document_id: str,
    binary_data: bytes,
    filename: str,
    content_type: Optional[str] = None,
) -> dict:
    """
    Async task to parse document into blocks.

    This function is designed to be called as a Celery task.
    To enable Celery integration, uncomment the @shared_task decorator
    and configure Celery in your application.

    Steps:
    1. Select parser via ParserFactory
    2. Parse document into blocks
    3. Save blocks to database
    4. Return parsing result

    Args:
        document_id: ID of the document to parse
        binary_data: Raw document binary content
        filename: Original filename
        content_type: MIME type of the document

    Returns:
        Dictionary with parsing result
    """
    # Uncomment to enable as Celery task:
    # from celery import shared_task
    # @shared_task(bind=True, max_retries=3)

    start_time = time.time()
    logger.info(f"Starting document parsing task for {document_id}: {filename}")

    try:
        # Import here to avoid circular imports
        from app.db.session import SessionLocal
        from app.models.document_block import DocumentBlock
        from app.services.document_parser import ParserFactory
        from app.services.document_parser.ocr import MockOCRService
        from app.services.document_parser.storage import LocalStorageService

        # Initialize services
        storage = LocalStorageService()
        ocr = MockOCRService()
        factory = ParserFactory(storage_service=storage, ocr_service=ocr)

        # Get appropriate parser
        parser = factory.get_parser(content_type=content_type, filename=filename)

        # Parse document
        blocks = parser.parse(binary_data, document_id, filename)

        # Save blocks to database
        db = SessionLocal()
        try:
            # Delete any existing blocks for this document
            existing_count = (
                db.query(DocumentBlock)
                .filter(DocumentBlock.document_id == document_id)
                .delete()
            )
            if existing_count > 0:
                logger.info(
                    f"Deleted {existing_count} existing blocks for document {document_id}"
                )

            # Insert new blocks
            now = datetime.utcnow()
            for block_data in blocks:
                db_block = DocumentBlock(
                    id=block_data.id or str(uuid.uuid4()),
                    document_id=document_id,
                    source_type=block_data.source_type.value
                    if hasattr(block_data.source_type, "value")
                    else block_data.source_type,
                    block_type=block_data.block_type.value
                    if hasattr(block_data.block_type, "value")
                    else block_data.block_type,
                    content=block_data.content,
                    editable=block_data.editable,
                    order_index=block_data.order_index,
                    source_ref=block_data.source_ref,
                    block_metadata=block_data.metadata,
                    created_at=now,
                    updated_at=now,
                )
                db.add(db_block)

            db.commit()
            logger.info(f"Saved {len(blocks)} blocks for document {document_id}")

        finally:
            db.close()

        elapsed_ms = int((time.time() - start_time) * 1000)
        logger.info(
            f"Document parsing completed for {document_id}: "
            f"{len(blocks)} blocks in {elapsed_ms}ms"
        )

        return {
            "document_id": document_id,
            "status": "completed",
            "total_blocks": len(blocks),
            "parse_time_ms": elapsed_ms,
        }

    except Exception as e:
        elapsed_ms = int((time.time() - start_time) * 1000)
        logger.error(
            f"Document parsing failed for {document_id}: {e}", exc_info=True
        )

        return {
            "document_id": document_id,
            "status": "failed",
            "error": str(e),
            "parse_time_ms": elapsed_ms,
        }


# Celery task wrapper - uncomment when Celery is configured
# from celery import shared_task
# parse_document_celery_task = shared_task(
#     bind=True,
#     max_retries=3,
#     default_retry_delay=60,
# )(parse_document_task)
