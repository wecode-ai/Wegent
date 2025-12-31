# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Document Parser API endpoints.

Provides endpoints for parsing documents into blocks, retrieving blocks,
and updating editable block content.
"""

import logging
import uuid
from datetime import datetime
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.api.dependencies import get_current_user, get_db
from app.models.document_block import DocumentBlock
from app.models.user import User
from app.schemas.document_block import (
    DocumentBlockListResponse,
    DocumentBlockResponse,
    DocumentBlockUpdate,
    ParseDocumentRequest,
    ParseDocumentResponse,
    SupportedFormatsResponse,
)
from app.services.document_parser import ParserFactory

logger = logging.getLogger(__name__)

router = APIRouter()


@router.get("/supported-formats", response_model=SupportedFormatsResponse)
async def get_supported_formats():
    """
    Get list of supported document formats.

    Returns supported MIME types and file extensions that can be parsed.
    """
    return SupportedFormatsResponse(
        content_types=ParserFactory.get_supported_content_types(),
        extensions=ParserFactory.get_supported_extensions(),
    )


@router.post("/documents/{document_id}/parse", response_model=ParseDocumentResponse)
async def trigger_parse(
    document_id: str,
    request: ParseDocumentRequest = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Trigger parsing of an uploaded document.

    This endpoint initiates document parsing. For large documents,
    parsing is performed asynchronously via Celery task.

    Args:
        document_id: ID of the document to parse
        request: Optional request body with parsing options
        db: Database session
        current_user: Current authenticated user

    Returns:
        Parsing status and result
    """
    force = request.force if request else False

    # Check if blocks already exist
    existing_blocks = (
        db.query(DocumentBlock)
        .filter(DocumentBlock.document_id == document_id)
        .count()
    )

    if existing_blocks > 0 and not force:
        return ParseDocumentResponse(
            document_id=document_id,
            status="completed",
            message="Document already parsed. Use force=true to re-parse.",
            total_blocks=existing_blocks,
        )

    # If forcing re-parse, delete existing blocks
    if force and existing_blocks > 0:
        db.query(DocumentBlock).filter(
            DocumentBlock.document_id == document_id
        ).delete()
        db.commit()
        logger.info(f"Deleted {existing_blocks} existing blocks for document {document_id}")

    # For now, return queued status - actual parsing will be done by Celery task
    # In production, you would call: parse_document_task.delay(document_id, ...)
    return ParseDocumentResponse(
        document_id=document_id,
        status="queued",
        message="Document parsing has been queued. Check /documents/{document_id}/blocks for results.",
        total_blocks=0,
    )


@router.post("/documents/{document_id}/parse-sync", response_model=ParseDocumentResponse)
async def parse_document_sync(
    document_id: str,
    binary_data: bytes = None,
    filename: str = None,
    content_type: str = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Synchronously parse a document (for testing/small documents).

    This endpoint parses the document immediately and returns results.
    For large documents, use the async /parse endpoint.

    Note: In production, this would receive binary_data from the attachment service.
    For now, this is a placeholder that demonstrates the parsing flow.

    Args:
        document_id: ID of the document to parse
        binary_data: Document binary content
        filename: Original filename
        content_type: MIME type of the document
        db: Database session
        current_user: Current authenticated user

    Returns:
        Parsing result with block count
    """
    if not binary_data or not filename:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="binary_data and filename are required for sync parsing",
        )

    try:
        # Initialize parser factory with mock services
        from app.services.document_parser.ocr import MockOCRService
        from app.services.document_parser.storage import LocalStorageService

        storage = LocalStorageService()
        ocr = MockOCRService()
        factory = ParserFactory(storage_service=storage, ocr_service=ocr)

        # Get appropriate parser
        parser = factory.get_parser(content_type=content_type, filename=filename)

        # Parse document
        blocks = parser.parse(binary_data, document_id, filename)

        # Save blocks to database
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
                metadata=block_data.metadata,
                created_at=now,
                updated_at=now,
            )
            db.add(db_block)

        db.commit()

        return ParseDocumentResponse(
            document_id=document_id,
            status="completed",
            message=f"Successfully parsed document into {len(blocks)} blocks",
            total_blocks=len(blocks),
        )

    except Exception as e:
        logger.error(f"Error parsing document {document_id}: {e}")
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to parse document: {str(e)}",
        )


@router.get("/documents/{document_id}/blocks", response_model=DocumentBlockListResponse)
async def get_blocks(
    document_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Get all blocks for a document.

    Returns blocks ordered by their order_index.

    Args:
        document_id: ID of the document
        db: Database session
        current_user: Current authenticated user

    Returns:
        List of document blocks
    """
    blocks = (
        db.query(DocumentBlock)
        .filter(DocumentBlock.document_id == document_id)
        .order_by(DocumentBlock.order_index)
        .all()
    )

    return DocumentBlockListResponse(
        document_id=document_id,
        total=len(blocks),
        blocks=[DocumentBlockResponse.model_validate(block) for block in blocks],
    )


@router.get("/blocks/{block_id}", response_model=DocumentBlockResponse)
async def get_block(
    block_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Get a single block by ID.

    Args:
        block_id: ID of the block
        db: Database session
        current_user: Current authenticated user

    Returns:
        Document block
    """
    block = db.query(DocumentBlock).filter(DocumentBlock.id == block_id).first()

    if not block:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Block {block_id} not found",
        )

    return DocumentBlockResponse.model_validate(block)


@router.patch("/blocks/{block_id}", response_model=DocumentBlockResponse)
async def update_block(
    block_id: str,
    update_data: DocumentBlockUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Update an editable block's content.

    Only blocks with editable=True can be updated.

    Args:
        block_id: ID of the block to update
        update_data: New content for the block
        db: Database session
        current_user: Current authenticated user

    Returns:
        Updated document block
    """
    block = db.query(DocumentBlock).filter(DocumentBlock.id == block_id).first()

    if not block:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Block {block_id} not found",
        )

    if not block.editable:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="This block is not editable",
        )

    block.content = update_data.content
    block.updated_at = datetime.utcnow()
    db.commit()
    db.refresh(block)

    return DocumentBlockResponse.model_validate(block)


@router.delete("/documents/{document_id}/blocks", status_code=status.HTTP_204_NO_CONTENT)
async def delete_document_blocks(
    document_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Delete all blocks for a document.

    Args:
        document_id: ID of the document
        db: Database session
        current_user: Current authenticated user
    """
    deleted_count = (
        db.query(DocumentBlock)
        .filter(DocumentBlock.document_id == document_id)
        .delete()
    )
    db.commit()

    logger.info(f"Deleted {deleted_count} blocks for document {document_id}")
