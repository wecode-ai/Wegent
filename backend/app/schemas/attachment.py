# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Attachment schemas for API responses and request validation.
"""

from typing import Optional

from pydantic import BaseModel


class TruncationInfo(BaseModel):
    """Information about content truncation."""

    is_truncated: bool = False
    original_length: Optional[int] = None
    truncated_length: Optional[int] = None
    truncation_message_key: Optional[str] = None  # i18n key for frontend


class AttachmentResponse(BaseModel):
    """Response model for attachment operations."""

    id: int
    filename: str
    file_size: int
    mime_type: str
    status: str
    text_length: Optional[int] = None
    error_message: Optional[str] = None
    error_code: Optional[str] = None  # Error code for i18n mapping
    truncation_info: Optional[TruncationInfo] = None

    class Config:
        from_attributes = True


class AttachmentDetailResponse(AttachmentResponse):
    """Detailed response model including subtask_id."""

    subtask_id: Optional[int] = None
    file_extension: str
    created_at: str
