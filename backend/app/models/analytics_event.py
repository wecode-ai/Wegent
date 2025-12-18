# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Analytics event model for tracking user behavior.
"""
from datetime import datetime

from sqlalchemy import Column, DateTime, Enum, Integer, String, Text

from app.db.base import Base


class AnalyticsEvent(Base):
    """Model for storing user behavior tracking events."""

    __tablename__ = "analytics_events"

    id = Column(Integer, primary_key=True, index=True)
    event_type = Column(
        Enum("click", "page_view", "error", name="event_type_enum"),
        nullable=False,
        index=True,
    )
    user_id = Column(Integer, nullable=True, index=True)
    page_url = Column(String(2048), nullable=False)
    timestamp = Column(DateTime, nullable=False, index=True)

    # Click event fields
    element_tag = Column(String(50), nullable=True)
    element_id = Column(String(255), nullable=True)
    element_class = Column(String(500), nullable=True)
    element_text = Column(String(100), nullable=True)
    element_href = Column(String(2048), nullable=True)
    data_track_id = Column(String(255), nullable=True, index=True)

    # Page view fields
    page_title = Column(String(500), nullable=True)
    referrer = Column(String(2048), nullable=True)

    # Error event fields
    error_type = Column(String(50), nullable=True, index=True)
    error_message = Column(Text, nullable=True)
    error_stack = Column(Text, nullable=True)
    error_source = Column(String(2048), nullable=True)
    error_line = Column(Integer, nullable=True)
    error_column = Column(Integer, nullable=True)

    # Metadata
    created_at = Column(DateTime, default=datetime.now, index=True)

    __table_args__ = (
        {"mysql_charset": "utf8mb4", "mysql_collate": "utf8mb4_unicode_ci"},
    )
