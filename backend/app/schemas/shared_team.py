# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from datetime import datetime
from typing import Optional

from pydantic import BaseModel


class SharedTeamCreate(BaseModel):
    """Shared team creation model"""

    user_id: int
    original_user_id: int
    team_id: int


class SharedTeamInDB(BaseModel):
    """Database shared team model"""

    id: int
    user_id: int
    original_user_id: int
    team_id: int
    is_active: bool
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class TeamShareRequest(BaseModel):
    """Team share request model"""

    team_id: int


class TeamShareResponse(BaseModel):
    """Team share response model"""

    share_url: str
    share_token: str


class TeamShareInfo(BaseModel):
    """Team share information model"""

    user_id: int
    user_name: str
    team_id: int
    team_name: str


class JoinSharedTeamRequest(BaseModel):
    """Join shared team request model"""

    share_token: str


class JoinSharedTeamResponse(BaseModel):
    """Join shared team response model"""

    message: str
    team_id: int
