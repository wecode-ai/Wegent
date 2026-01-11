# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Internal API endpoints for summary callbacks.

These endpoints are called by the executor after summary generation completes.
They use Service API Key authentication (key_type="service").
"""

import hashlib
import logging
from typing import Optional

from fastapi import APIRouter, Depends, Header, HTTPException, status
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.models.api_key import KEY_TYPE_SERVICE, APIKey
from app.schemas.knowledge import (
    DocumentSummaryCallbackRequest,
    KnowledgeBaseSummaryCallbackRequest,
)
from app.services.knowledge.summary_service import SummaryService

logger = logging.getLogger(__name__)

router = APIRouter()


def verify_service_api_key(
    db: Session,
    api_key: str,
) -> bool:
    """
    Verify that the API key is a valid service key.

    Args:
        db: Database session
        api_key: API key to verify

    Returns:
        True if valid

    Raises:
        HTTPException: If key is invalid
    """
    if not api_key:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="API key is required",
        )

    # Remove "Bearer " prefix if present
    if api_key.startswith("Bearer "):
        api_key = api_key[7:]

    # Hash the key for lookup
    key_hash = hashlib.sha256(api_key.encode()).hexdigest()

    # Find the key in database
    db_key = (
        db.query(APIKey)
        .filter(
            APIKey.key_hash == key_hash,
            APIKey.is_active == True,
            APIKey.key_type == KEY_TYPE_SERVICE,
        )
        .first()
    )

    if not db_key:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired API key",
        )

    return True


def get_api_key_from_header(
    authorization: Optional[str] = Header(None, alias="Authorization"),
    x_api_key: Optional[str] = Header(None, alias="X-API-Key"),
) -> str:
    """
    Extract API key from Authorization header or X-API-Key header.

    Args:
        authorization: Authorization header value
        x_api_key: X-API-Key header value

    Returns:
        API key string

    Raises:
        HTTPException: If no API key provided
    """
    if x_api_key:
        return x_api_key

    if authorization:
        if authorization.startswith("Bearer "):
            return authorization[7:]
        return authorization

    raise HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="API key is required",
    )


@router.post("/summary/document/{document_id}")
def document_summary_callback(
    document_id: int,
    data: DocumentSummaryCallbackRequest,
    api_key: str = Depends(get_api_key_from_header),
    db: Session = Depends(get_db),
):
    """
    Callback endpoint for document summary completion.

    Called by the executor after document summary generation completes.
    Requires Service API Key authentication.

    Args:
        document_id: Document ID
        data: Summary callback data
        api_key: Service API key
        db: Database session

    Returns:
        Success status
    """
    # Verify service API key
    verify_service_api_key(db, api_key)

    logger.info(
        f"Received document summary callback for document {document_id}, "
        f"status: {data.status}"
    )

    success = SummaryService.update_document_summary(
        db=db,
        document_id=document_id,
        data=data,
    )

    if not success:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Document {document_id} not found",
        )

    return {"status": "success", "document_id": document_id}


@router.post("/summary/knowledge-base/{kb_id}")
def kb_summary_callback(
    kb_id: int,
    data: KnowledgeBaseSummaryCallbackRequest,
    api_key: str = Depends(get_api_key_from_header),
    db: Session = Depends(get_db),
):
    """
    Callback endpoint for knowledge base summary completion.

    Called by the executor after knowledge base summary generation completes.
    Requires Service API Key authentication.

    Args:
        kb_id: Knowledge base ID
        data: Summary callback data
        api_key: Service API key
        db: Database session

    Returns:
        Success status
    """
    # Verify service API key
    verify_service_api_key(db, api_key)

    logger.info(
        f"Received knowledge base summary callback for KB {kb_id}, "
        f"status: {data.status}"
    )

    success = SummaryService.update_kb_summary(
        db=db,
        kb_id=kb_id,
        data=data,
    )

    if not success:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Knowledge base {kb_id} not found",
        )

    return {"status": "success", "knowledge_base_id": kb_id}
