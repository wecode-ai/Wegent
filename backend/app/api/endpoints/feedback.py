# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Authenticated Wework feedback endpoint."""

import json

from fastapi import (
    APIRouter,
    Depends,
    File,
    Form,
    HTTPException,
    Request,
    UploadFile,
    status,
)
from pydantic import ValidationError
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core.config import settings
from app.core.rate_limit import get_limiter
from app.schemas.feedback import FeedbackCreate, FeedbackResponse
from app.services.feedback_service import feedback_service

router = APIRouter()
limiter = get_limiter()


@router.post("", response_model=FeedbackResponse, status_code=status.HTTP_201_CREATED)
@limiter.limit(settings.WEWORK_FEEDBACK_RATE_LIMIT)
def submit_feedback(
    request: Request,
    report_id: str = Form(...),
    title: str = Form(...),
    description: str = Form(""),
    context: str = Form("{}"),
    bundle: UploadFile = File(...),
    db: Session = Depends(get_db),
) -> FeedbackResponse:
    try:
        parsed_context = json.loads(context)
        values = FeedbackCreate(
            report_id=report_id,
            title=title,
            description=description,
            context=parsed_context,
        )
    except (json.JSONDecodeError, ValidationError) as error:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(error)) from error
    if not isinstance(parsed_context, dict):
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY, "context must be an object"
        )
    return feedback_service.submit(db, values, bundle)
