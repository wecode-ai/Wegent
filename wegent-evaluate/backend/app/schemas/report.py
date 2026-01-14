"""
Schemas for report API endpoints.
"""
from datetime import datetime
from typing import Optional

from pydantic import BaseModel


class WeeklyReportRequest(BaseModel):
    """Request body for generating a weekly report."""

    version_id: int


class WeeklyReportResponse(BaseModel):
    """Response for weekly report generation."""

    markdown: str
    generated_at: datetime
    version_id: int
    version_name: str
