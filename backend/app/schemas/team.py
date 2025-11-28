# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from datetime import datetime
from typing import Any, Optional, List

from pydantic import BaseModel

from app.schemas.user import UserInDB
from app.schemas.bot import BotInDB

class BotInfo(BaseModel):
    """Bot information model"""
    bot_id: int
    bot_prompt: Optional[str] = None
    role: Optional[str] = None

class BotDetailInfo(BaseModel):
    """Bot detail information model with bot object"""
    bot: BotInDB
    bot_prompt: Optional[str] = None
    role: Optional[str] = None

class TeamBase(BaseModel):
    """Team base model"""
    name: str
    bots: List[BotInfo]
    workflow: Optional[dict[str, Any]] = None
    is_active: bool = True

class TeamCreate(TeamBase):
    """Team creation model"""
    pass

class TeamUpdate(BaseModel):
    """Team update model"""
    name: Optional[str] = None
    bots: Optional[List[BotInfo]] = None
    workflow: Optional[dict[str, Any]] = None
    is_active: Optional[bool] = None

class TeamInDB(TeamBase):
    """Database team model"""
    id: int
    user_id: int
    created_at: datetime
    updated_at: datetime
    user: Optional[dict[str, Any]] = None
    share_status: int = 0  # 0-private, 1-sharing, 2-shared from others
    agent_type: Optional[str] = None  # agno, claude, dify, etc.

    class Config:
        from_attributes = True


class TeamDetail(BaseModel):
    """Detailed team model with related entities"""
    id: int
    name: str
    bots: List[BotDetailInfo]
    workflow: Optional[dict[str, Any]] = None
    is_active: bool = True
    created_at: datetime
    updated_at: datetime
    user: Optional[UserInDB] = None
    share_status: int = 0  # 0-private, 1-sharing, 2-shared from others

    class Config:
        from_attributes = True

class TeamListResponse(BaseModel):
    """Team paginated response model"""
    total: int
    items: list[TeamInDB]