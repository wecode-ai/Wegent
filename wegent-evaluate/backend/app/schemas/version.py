"""
Schemas for version API endpoints.
"""
from datetime import datetime
from typing import List, Literal, Optional

from pydantic import BaseModel


class DataVersionResponse(BaseModel):
    """Response for a single data version."""

    id: int
    name: str
    description: Optional[str] = None
    created_at: datetime
    last_sync_time: Optional[datetime] = None
    sync_count: int

    class Config:
        from_attributes = True


class DataVersionListResponse(BaseModel):
    """Response for version list endpoint."""

    items: List[DataVersionResponse]
    total: int


class DataVersionCreateRequest(BaseModel):
    """Request body for creating a new version."""

    description: Optional[str] = None
