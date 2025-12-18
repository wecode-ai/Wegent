# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Pydantic schemas for analytics events.
"""
from datetime import datetime
from typing import Literal, Optional

from pydantic import BaseModel, Field


class AnalyticsEventCreate(BaseModel):
    """Schema for creating an analytics event."""

    event_type: Literal["click", "page_view", "error"]
    user_id: Optional[int] = None
    page_url: str = Field(..., max_length=2048)
    timestamp: datetime

    # Click event fields
    element_tag: Optional[str] = Field(None, max_length=50)
    element_id: Optional[str] = Field(None, max_length=255)
    element_class: Optional[str] = Field(None, max_length=500)
    element_text: Optional[str] = Field(None, max_length=100)
    element_href: Optional[str] = Field(None, max_length=2048)
    data_track_id: Optional[str] = Field(None, max_length=255)

    # Page view fields
    page_title: Optional[str] = Field(None, max_length=500)
    referrer: Optional[str] = Field(None, max_length=2048)

    # Error fields
    error_type: Optional[
        Literal["js_error", "unhandled_rejection", "api_error", "resource_error"]
    ] = None
    error_message: Optional[str] = None
    error_stack: Optional[str] = Field(None, max_length=2000)
    error_source: Optional[str] = Field(None, max_length=2048)
    error_line: Optional[int] = None
    error_column: Optional[int] = None


class AnalyticsEventResponse(BaseModel):
    """Schema for analytics event response."""

    id: int
    event_type: str
    created_at: datetime

    model_config = {"from_attributes": True}
