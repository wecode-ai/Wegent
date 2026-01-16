# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
API endpoints for data table management and operations.
"""

import logging

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core import security
from app.models.user import User
from app.schemas.knowledge import (
    KnowledgeDocumentListResponse,
    KnowledgeDocumentResponse,
    TableUrlValidationRequest,
    TableUrlValidationResponse,
)
from app.services.knowledge import KnowledgeService
from app.services.tables import DataTableService, TableQueryRequest
from app.services.tables.providers import DingTalkProvider  # noqa: F401
from app.services.tables.url_parser import TableURLParser

logger = logging.getLogger(__name__)

router = APIRouter()


@router.get("", response_model=KnowledgeDocumentListResponse)
def list_table_documents(
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """
    List all table documents accessible to the current user.

    Returns documents with source_type='table' from all accessible knowledge bases.
    Supports multiple providers: DingTalk, Feishu, etc.
    """
    documents = KnowledgeService.list_table_documents(
        db=db,
        user_id=current_user.id,
    )
    return KnowledgeDocumentListResponse(
        total=len(documents),
        items=[KnowledgeDocumentResponse.model_validate(doc) for doc in documents],
    )


@router.get("/{document_id}", response_model=KnowledgeDocumentResponse)
def get_table_document(
    document_id: int,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """
    Get a table document by ID.
    """
    document = KnowledgeService.get_table_document_by_id(
        db=db,
        document_id=document_id,
        user_id=current_user.id,
    )
    if not document:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Table document not found or access denied",
        )
    return KnowledgeDocumentResponse.model_validate(document)


@router.post("/query")
async def query_table(
    request: dict,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """
    Query table data.

    Used by ChatShell's DataTableTool to fetch table data.

    Request body:
    {
        "provider": "dingtalk",
        "base_id": "dst...",
        "sheet_id_or_name": "tbl...",
        "user_name": "username",  // optional
        "max_records": 100,  // optional
        "filters": {}  // optional
    }

    Returns:
    {
        "schema": {"field1": "type1", "field2": "type2"},
        "records": [{"field1": "value1", "field2": "value2"}, ...],
        "total_count": 100
    }
    """
    try:
        # Parse request
        query_request = TableQueryRequest(
            provider=request.get("provider", "dingtalk"),
            base_id=request["base_id"],
            sheet_id_or_name=request["sheet_id_or_name"],
            user_name=request.get("user_name") or current_user.user_name,
            max_records=request.get("max_records", 100),
            filters=request.get("filters"),
        )

        # Create service and query
        service = DataTableService()
        result = await service.query_table(query_request)

        return result.model_dump()

    except Exception as e:
        logger.error(f"[query_table] Error: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to query table: {str(e)}",
        )


@router.post("/validate-url", response_model=TableUrlValidationResponse)
async def validate_table_url(
    data: TableUrlValidationRequest,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """
    Validate a table URL and extract metadata.

    Performs the following validations:
    1. URL format validation - checks if it's a valid URL
    2. Provider detection - identifies the table provider (e.g., DingTalk)
    3. URL parsing - extracts baseId and sheetId from the URL
    4. DingTalk ID validation - checks if current user has dingtalk_id
    5. Table access validation - verifies user can access the table data

    Returns validation result with extracted metadata or error details.

    Error codes:
    - INVALID_URL_FORMAT: URL is not a valid URL format
    - UNSUPPORTED_PROVIDER: URL is not from a supported table provider
    - PARSE_FAILED: Failed to parse the URL to extract table information
    - MISSING_DINGTALK_ID: User does not have DingTalk ID configured
    - TABLE_ACCESS_FAILED: Failed to access table data
    """
    from urllib.parse import urlparse

    url = data.url.strip()

    # Step 1: Validate URL format
    try:
        parsed = urlparse(url)
        if not parsed.scheme or not parsed.netloc:
            return TableUrlValidationResponse(
                valid=False,
                error_code="INVALID_URL_FORMAT",
                error_message="Please enter a valid URL format",
            )
        # Check if scheme is http or https
        if parsed.scheme not in ("http", "https"):
            return TableUrlValidationResponse(
                valid=False,
                error_code="INVALID_URL_FORMAT",
                error_message="URL must start with http:// or https://",
            )
    except Exception:
        return TableUrlValidationResponse(
            valid=False,
            error_code="INVALID_URL_FORMAT",
            error_message="Please enter a valid URL format",
        )

    # Step 2: Detect provider
    provider = TableURLParser.detect_provider_from_url(url)
    if not provider:
        return TableUrlValidationResponse(
            valid=False,
            error_code="UNSUPPORTED_PROVIDER",
            error_message="URL is not from a supported table provider. Supported providers: DingTalk",
        )

    # Step 3: Parse URL to extract table information
    context = TableURLParser.parse_url(url)
    if not context:
        return TableUrlValidationResponse(
            valid=False,
            provider=provider,
            error_code="PARSE_FAILED",
            error_message="Unable to extract table information from the URL. Please check the URL format",
        )

    # Step 4 & 5: Validate table access using new DataTableService
    try:
        service = DataTableService()

        # Use the new validate_url method
        # This may raise exceptions for 500 errors or linked table issues
        valid = await service.validate_url(
            url=url,
            provider_name=provider,
            user_name=current_user.user_name,
        )

        if not valid:
            # validate_url returned False (permission or access issues)
            # Try to get more specific error by attempting to query
            try:
                query_request = TableQueryRequest(
                    provider=provider,
                    base_id=context.base_id,
                    sheet_id_or_name=context.sheet_id_or_name,
                    user_name=current_user.user_name,
                    max_records=1,
                )
                await service.query_table(query_request)
            except Exception as query_error:
                error_str = str(query_error).lower()
                # Check for common error patterns
                if "dingtalk" in error_str and (
                    "id" in error_str or "auth" in error_str
                ):
                    return TableUrlValidationResponse(
                        valid=False,
                        provider=provider,
                        base_id=context.base_id,
                        sheet_id=context.sheet_id_or_name,
                        error_code="MISSING_DINGTALK_ID",
                        error_message="You do not have a DingTalk ID configured. Please log in using DingTalk to access table documents.",
                    )
                elif (
                    "500" in error_str
                    or "internal" in error_str
                    or "linked" in error_str
                ):
                    return TableUrlValidationResponse(
                        valid=False,
                        provider=provider,
                        base_id=context.base_id,
                        sheet_id=context.sheet_id_or_name,
                        error_code="TABLE_ACCESS_FAILED_LINKED_TABLE",
                        error_message="The table might be a linked table. Please use the original table link.",
                    )

            return TableUrlValidationResponse(
                valid=False,
                provider=provider,
                base_id=context.base_id,
                sheet_id=context.sheet_id_or_name,
                error_code="TABLE_ACCESS_FAILED",
                error_message="Failed to access table. Please check your permissions and ensure you have access rights.",
            )

    except Exception as e:
        # Caught exception from validate_url (500 errors, etc.)
        logger.error(f"Table access validation failed: {str(e)}", exc_info=True)
        error_str = str(e).lower()

        # Check for 500 or internal server errors (likely linked table)
        if "500" in error_str or "internal" in error_str or "linked" in error_str:
            return TableUrlValidationResponse(
                valid=False,
                provider=provider,
                base_id=context.base_id,
                sheet_id=context.sheet_id_or_name,
                error_code="TABLE_ACCESS_FAILED_LINKED_TABLE",
                error_message="The table might be a linked table. Please use the original table link.",
            )

        # Provide more specific error messages based on error type
        if "missing 'dingtalk' configuration" in error_str:
            return TableUrlValidationResponse(
                valid=False,
                provider=provider,
                base_id=context.base_id,
                sheet_id=context.sheet_id_or_name,
                error_code="CONFIG_ERROR",
                error_message="Server configuration error: DingTalk integration not properly configured.",
            )

        return TableUrlValidationResponse(
            valid=False,
            provider=provider,
            base_id=context.base_id,
            sheet_id=context.sheet_id_or_name,
            error_code="TABLE_ACCESS_FAILED",
            error_message=f"Failed to access table: {str(e)}",
        )

    # All validations passed
    return TableUrlValidationResponse(
        valid=True,
        provider=provider,
        base_id=context.base_id,
        sheet_id=context.sheet_id_or_name,
    )
