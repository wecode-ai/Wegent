# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Schemas for task invite link functionality.
"""

from datetime import datetime
from typing import Optional

from pydantic import BaseModel


class GenerateInviteLinkRequest(BaseModel):
    """Request to generate an invite link"""

    expires_hours: int = 72  # Default 72 hours


class InviteLinkResponse(BaseModel):
    """Response containing the generated invite link"""

    invite_url: str
    invite_token: str
    expires_hours: int


class InviteInfoResponse(BaseModel):
    """Response containing invite information (public, no auth required)"""

    task_id: int
    task_title: str
    inviter_id: int
    inviter_name: str
    team_name: Optional[str] = None
    member_count: int
    expires_at: str


class JoinByInviteResponse(BaseModel):
    """Response after joining via invite link"""

    message: str
    task_id: int
    already_member: bool
