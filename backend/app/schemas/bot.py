# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from datetime import datetime
from typing import Any, List, Optional

from pydantic import BaseModel

from app.schemas.user import UserInDB


class BotBase(BaseModel):
    """Bot base model"""

    name: str
    agent_name: str
    agent_config: dict[str, Any]
    system_prompt: Optional[str] = None
    mcp_servers: Optional[dict[str, Any]] = None
    skills: Optional[List[str]] = None
    is_active: bool = True


class BotCreate(BotBase):
    """Bot creation model"""

    pass


class BotUpdate(BaseModel):
    """Bot update model"""

    name: Optional[str] = None
    agent_name: Optional[str] = None
    agent_config: Optional[dict[str, Any]] = None
    system_prompt: Optional[str] = None
    mcp_servers: Optional[dict[str, Any]] = None
    skills: Optional[List[str]] = None
    is_active: Optional[bool] = None


class BotInDB(BotBase):
    """Database bot model"""

    id: int
    user_id: int
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class BotDetail(BaseModel):
    """Detailed bot model with related entities"""

    id: int
    name: str
    agent_name: str
    agent_config: dict[str, Any]
    system_prompt: Optional[str] = None
    mcp_servers: Optional[dict[str, Any]] = None
    skills: Optional[List[str]] = None
    is_active: bool = True
    created_at: datetime
    updated_at: datetime
    user: Optional[UserInDB] = None

    class Config:
        from_attributes = True


class BotListResponse(BaseModel):
    """Bot paginated response model"""

    total: int
    items: list[BotInDB]
