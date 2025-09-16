# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from datetime import datetime
from typing import Any, Optional, List
from enum import Enum

from pydantic import BaseModel, Field

from app.schemas.user import UserInDB
from app.schemas.bot import BotInDB


class TeamMode(str, Enum):
    """Team workflow mode enumeration"""
    pipeline = "pipeline"
    route = "route"
    coordinate = "coordinate"
    collaborate = "collaborate"


class TeamWorkflow(BaseModel):
    """Team workflow configuration"""
    mode: TeamMode = Field(default=TeamMode.pipeline, description="Workflow mode")
    system_prompt: Optional[str] = Field(default=None, description="System prompt for the team")

class BotInfo(BaseModel):
    """Bot information model"""
    bot_id: int
    bot_prompt: Optional[str] = None

class BotDetailInfo(BaseModel):
    """Bot detail information model with bot object"""
    bot: BotInDB
    bot_prompt: Optional[str] = None

class TeamBase(BaseModel):
    """Team base model"""
    name: str
    bots: List[BotInfo]
    workflow: Optional[TeamWorkflow] = None
    is_active: bool = True

class TeamCreate(TeamBase):
    """Team creation model"""
    pass

class TeamUpdate(BaseModel):
    """Team update model"""
    name: Optional[str] = None
    bots: Optional[List[BotInfo]] = None
    workflow: Optional[TeamWorkflow] = None
    is_active: Optional[bool] = None

class TeamInDB(TeamBase):
    """Database team model"""
    id: int
    user_id: int
    k_id: Optional[int] = None
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class TeamDetail(BaseModel):
    """Detailed team model with related entities"""
    id: int
    name: str
    bots: List[BotDetailInfo]
    workflow: Optional[TeamWorkflow] = None
    is_active: bool = True
    created_at: datetime
    updated_at: datetime
    user: Optional[UserInDB] = None

    class Config:
        from_attributes = True

class TeamListResponse(BaseModel):
    """Team paginated response model"""
    total: int
    items: list[TeamInDB]