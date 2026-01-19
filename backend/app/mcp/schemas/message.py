# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Message-related schemas for MCP interactive tools.
"""

from typing import List, Literal, Optional

from pydantic import BaseModel, Field


class Attachment(BaseModel):
    """Attachment reference for messages."""

    name: str = Field(..., description="File name")
    url: str = Field(..., description="File access URL")
    mime_type: str = Field(..., description="MIME type (e.g., 'image/png', 'application/pdf')")
    size: Optional[int] = Field(None, description="File size in bytes")


class SendMessageInput(BaseModel):
    """Input parameters for send_message tool."""

    content: str = Field(..., description="Message content (supports Markdown)")
    message_type: Literal["text", "markdown"] = Field(
        "markdown", description="Message type: text for plain text, markdown for rich text"
    )
    attachments: Optional[List[Attachment]] = Field(
        None, description="Optional list of attachments"
    )


class SendMessageResult(BaseModel):
    """Result from send_message tool."""

    success: bool = Field(..., description="Whether the message was sent successfully")
    message_id: str = Field(..., description="Unique identifier for the sent message")
    error: Optional[str] = Field(None, description="Error message if failed")
