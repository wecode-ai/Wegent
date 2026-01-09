# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from datetime import datetime
from typing import Any, List, Optional

from pydantic import BaseModel

from app.schemas.bot import BotInDB
from app.schemas.user import UserInDB


class BotSummary(BaseModel):
    """Bot summary model with only necessary fields for team list"""

    agent_config: Optional[dict[str, Any]] = None
    agent_name: Optional[str] = None
    shell_type: Optional[str] = None  # Shell type (e.g., "Chat", "Docker", "Dify")


class BotInfo(BaseModel):
    """Bot information model"""

    bot_id: int
    bot_prompt: Optional[str] = None
    role: Optional[str] = None
    requireConfirmation: Optional[bool] = (
        False  # Pipeline mode: pause after this stage for user confirmation
    )
    bot: Optional[BotSummary] = None


class BotDetailInfo(BaseModel):
    """Bot detail information model with bot object"""

    bot: BotInDB
    bot_prompt: Optional[str] = None
    role: Optional[str] = None


class TeamBase(BaseModel):
    """Team base model"""

    name: str
    description: Optional[str] = None  # Team description
    bots: List[BotInfo]
    workflow: Optional[dict[str, Any]] = None
    bind_mode: Optional[List[str]] = None  # ['chat', 'code'] or empty list for none
    is_active: bool = True
    icon: Optional[str] = None  # Icon ID from preset icon library


class TeamCreate(TeamBase):
    """Team creation model"""

    namespace: str = (
        "default"  # Group namespace, defaults to 'default' for personal teams
    )


class TeamUpdate(BaseModel):
    """Team update model"""

    name: Optional[str] = None
    description: Optional[str] = None  # Team description
    bots: Optional[List[BotInfo]] = None
    workflow: Optional[dict[str, Any]] = None
    bind_mode: Optional[List[str]] = None  # ['chat', 'code'] or empty list for none
    is_active: Optional[bool] = None
    namespace: Optional[str] = None  # Group namespace
    icon: Optional[str] = None  # Icon ID from preset icon library


class TeamInDB(TeamBase):
    """Database team model"""

    id: int
    user_id: int
    namespace: Optional[str] = "default"  # Group namespace
    created_at: datetime
    updated_at: datetime
    user: Optional[dict[str, Any]] = None
    share_status: int = 0  # 0-private, 1-sharing, 2-shared from others
    agent_type: Optional[str] = None  # agno, claude, dify, etc.
    bind_mode: Optional[List[str]] = None  # ['chat', 'code'] or empty list for none

    class Config:
        from_attributes = True


class TeamDetail(BaseModel):
    """Detailed team model with related entities"""

    id: int
    name: str
    description: Optional[str] = None  # Team description
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
