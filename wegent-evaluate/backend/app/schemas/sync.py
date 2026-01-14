"""
Schemas for sync API endpoints.
"""
from datetime import datetime
from typing import List, Literal, Optional

from pydantic import BaseModel, field_validator


class SyncTriggerRequest(BaseModel):
    """Request body for triggering a sync job."""

    start_time: datetime
    end_time: datetime
    user_id: Optional[int] = None
    # Version mode: "new" creates a new version, "existing" uses an existing version
    version_mode: Literal["new", "existing"] = "new"
    # Version ID (required when version_mode="existing")
    version_id: Optional[int] = None
    # Write mode for existing version: "append" or "replace"
    write_mode: Optional[Literal["append", "replace"]] = None
    # Description for new version
    version_description: Optional[str] = None

    @field_validator("version_id")
    @classmethod
    def validate_version_id(cls, v, info):
        """Validate version_id is provided when version_mode is 'existing'."""
        if info.data.get("version_mode") == "existing" and v is None:
            raise ValueError("version_id is required when version_mode is 'existing'")
        return v

    @field_validator("write_mode")
    @classmethod
    def validate_write_mode(cls, v, info):
        """Validate write_mode is provided when version_mode is 'existing'."""
        if info.data.get("version_mode") == "existing" and v is None:
            raise ValueError("write_mode is required when version_mode is 'existing'")
        return v


class SyncTriggerResponse(BaseModel):
    """Response for sync trigger endpoint."""

    sync_id: str
    status: str
    message: str
    version_id: Optional[int] = None


class SyncStatusResponse(BaseModel):
    """Response for sync status endpoint."""

    sync_id: str
    status: str
    total_fetched: int
    total_inserted: int
    total_skipped: int
    error_message: Optional[str] = None
    version_id: Optional[int] = None


class SyncHistoryItem(BaseModel):
    """Single sync job in history list."""

    sync_id: str
    start_time: datetime
    end_time: datetime
    user_id: Optional[int] = None
    version_id: Optional[int] = None
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
