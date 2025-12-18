# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Analytics API endpoints for user behavior tracking.
"""
from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.schemas.analytics import AnalyticsEventCreate, AnalyticsEventResponse
from app.services.analytics_service import AnalyticsService

router = APIRouter()


@router.post("/events", response_model=AnalyticsEventResponse, status_code=201)
async def create_event(
    event: AnalyticsEventCreate,
    db: Session = Depends(get_db),
):
    """
    Record a user behavior event.

    This endpoint does not require authentication to allow tracking
    of anonymous users. Events are stored for analytics purposes.

    Args:
        event: The analytics event data to record.
        db: Database session dependency.

    Returns:
        The created analytics event with id and created_at timestamp.
    """
    service = AnalyticsService(db)
    return service.create_event(event)
