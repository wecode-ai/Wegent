# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Response schemas for MCP interactive tools.
"""

from typing import Any, Dict, Literal, Optional

from pydantic import BaseModel, Field


class InteractiveResponseData(BaseModel):
    """Data submitted by user in response to interactive messages."""

    request_id: str = Field(..., description="Original request ID")
    response_type: Literal["form_submit", "confirm", "select"] = Field(
        ..., description="Type of response"
    )
    data: Dict[str, Any] = Field(..., description="User submitted data")
