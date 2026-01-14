# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Unified form submission API endpoints.

Provides a single endpoint for all form submissions with pluggable handlers.
"""

import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core import security
from app.models.user import User
from app.schemas.form import (
    FormContext,
    FormSubmissionDetail,
    FormSubmissionRequest,
    FormSubmissionResponse,
    FormSubmissionStatusEnum,
)
from app.services.forms.registry import (
    get_registered_action_types,
    is_action_type_registered,
)
from app.services.forms.service import get_form_submission_service

# Import handlers to trigger registration
import app.services.forms.handlers  # noqa: F401

router = APIRouter()
logger = logging.getLogger(__name__)


@router.post("/submit", response_model=FormSubmissionResponse)
async def submit_form(
    request: FormSubmissionRequest,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """
    Submit a form for processing.

    This unified endpoint handles all form types based on action_type.
    The form data is validated and processed by the appropriate handler.

    Args:
        request: Form submission request with action_type, form_data, and context
        current_user: Authenticated user
        db: Database session

    Returns:
        FormSubmissionResponse with submission_id and status

    Raises:
        HTTPException: 400 if action_type is unknown
        HTTPException: 422 if form validation fails
    """
    # Validate action_type is registered
    if not is_action_type_registered(request.action_type):
        available = get_registered_action_types()
        raise HTTPException(
            status_code=400,
            detail={
                "error": f"Unknown action_type: {request.action_type}",
                "available_types": available,
            },
        )

    # Get service instance
    service = get_form_submission_service(db)

    # Convert context model to dict
    context_dict = request.context.model_dump() if request.context else {}

    # Create submission record
    submission = service.create_submission(
        action_type=request.action_type,
        form_data=request.form_data,
        context=context_dict,
        user_id=current_user.id,
    )

    # Process submission
    result = await service.process_submission(
        submission_id=submission.id,
        action_type=request.action_type,
        form_data=request.form_data,
        context=context_dict,
        user_id=current_user.id,
    )

    # Get updated submission for response
    submission = service.get_submission(submission.id)

    return FormSubmissionResponse(
        submission_id=submission.id,
        status=FormSubmissionStatusEnum(submission.status.value),
        message=result.message,
        result=result.data if result.success else None,
    )


@router.get("/submissions/{submission_id}", response_model=FormSubmissionDetail)
def get_submission(
    submission_id: str,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """
    Get details of a form submission.

    Args:
        submission_id: UUID of the submission
        current_user: Authenticated user
        db: Database session

    Returns:
        FormSubmissionDetail with full submission data

    Raises:
        HTTPException: 404 if submission not found or doesn't belong to user
    """
    service = get_form_submission_service(db)
    submission = service.get_submission(submission_id)

    if not submission:
        raise HTTPException(status_code=404, detail="Submission not found")

    # Verify ownership
    if submission.user_id != current_user.id:
        raise HTTPException(status_code=404, detail="Submission not found")

    return FormSubmissionDetail(
        id=submission.id,
        action_type=submission.action_type,
        form_data=submission.form_data,
        context=submission.context,
        status=FormSubmissionStatusEnum(submission.status.value),
        result=submission.result,
        error_message=submission.error_message,
        created_at=submission.created_at,
        updated_at=submission.updated_at,
    )


@router.get("/submissions", response_model=list[FormSubmissionDetail])
def list_submissions(
    action_type: Optional[str] = Query(None, description="Filter by action type"),
    task_id: Optional[int] = Query(None, description="Filter by task ID"),
    limit: int = Query(20, ge=1, le=100, description="Maximum results"),
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """
    List form submissions for the current user.

    Args:
        action_type: Optional action type filter
        task_id: Optional task ID filter
        limit: Maximum number of results
        current_user: Authenticated user
        db: Database session

    Returns:
        List of FormSubmissionDetail objects
    """
    service = get_form_submission_service(db)
    submissions = service.get_user_submissions(
        user_id=current_user.id,
        action_type=action_type,
        task_id=task_id,
        limit=limit,
    )

    return [
        FormSubmissionDetail(
            id=s.id,
            action_type=s.action_type,
            form_data=s.form_data,
            context=s.context,
            status=FormSubmissionStatusEnum(s.status.value),
            result=s.result,
            error_message=s.error_message,
            created_at=s.created_at,
            updated_at=s.updated_at,
        )
        for s in submissions
    ]


@router.get("/action-types")
def list_action_types():
    """
    List all registered form action types.

    Returns:
        List of available action type strings
    """
    return {"action_types": get_registered_action_types()}
