# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Analytics service for handling user behavior tracking events.
"""
from sqlalchemy.orm import Session

from app.models.analytics_event import AnalyticsEvent
from app.schemas.analytics import AnalyticsEventCreate


class AnalyticsService:
    """Service class for analytics event operations."""

    def __init__(self, db: Session):
        """Initialize analytics service with database session."""
        self.db = db

    def create_event(self, event_data: AnalyticsEventCreate) -> AnalyticsEvent:
        """
        Create a new analytics event record.

        Args:
            event_data: The event data to store.

        Returns:
            The created AnalyticsEvent instance.
        """
        event = AnalyticsEvent(**event_data.model_dump())
        self.db.add(event)
        self.db.commit()
        self.db.refresh(event)
        return event
