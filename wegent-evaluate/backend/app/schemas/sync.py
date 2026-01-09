"""
Schemas for sync API endpoints.
"""
from datetime import datetime
from typing import List, Optional

from pydantic import BaseModel


class SyncTriggerRequest(BaseModel):
    """Request body for triggering a sync job."""

    start_time: datetime
    end_time: datetime
    user_id: Optional[int] = None


class SyncTriggerResponse(BaseModel):
    """Response for sync trigger endpoint."""

    sync_id: str
    status: str
    message: str


class SyncStatusResponse(BaseModel):
    """Response for sync status endpoint."""

    sync_id: str
    status: str
    total_fetched: int
    total_inserted: int
    total_skipped: int
    error_message: Optional[str] = None


class SyncHistoryItem(BaseModel):
    """Single sync job in history list."""

    sync_id: str
    start_time: datetime
    end_time: datetime
    user_id: Optional[int] = None
    status: str
    total_fetched: int
    total_inserted: int
    total_skipped: int
    error_message: Optional[str] = None
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class SyncHistoryResponse(BaseModel):
    """Response for sync history endpoint."""

    items: List[SyncHistoryItem]
    total: int
    page: int
    page_size: int
    total_pages: int
