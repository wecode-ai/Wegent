# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from datetime import datetime
from typing import Any, List, Optional

from pydantic import BaseModel

from app.schemas.user import UserInDB


class BotCreate(BaseModel):
    """Bot creation model - request schema"""

    name: str
    shell_name: str  # Shell name (e.g., 'ClaudeCode', 'Agno', 'my-custom-shell')
    agent_config: dict[str, Any]
    system_prompt: Optional[str] = None
    mcp_servers: Optional[dict[str, Any]] = None
    skills: Optional[List[str]] = None
    preload_skills: Optional[List[str]] = None  # Skills to preload into system prompt
    namespace: Optional[str] = (
        "default"  # Namespace for the bot (group name or 'default')
    )
    is_active: bool = True


class BotUpdate(BaseModel):
    """Bot update model - request schema"""

    name: Optional[str] = None
    shell_name: Optional[str] = (
        None  # Shell name (e.g., 'ClaudeCode', 'Agno', 'my-custom-shell')
    )
    agent_config: Optional[dict[str, Any]] = None
    system_prompt: Optional[str] = None
    mcp_servers: Optional[dict[str, Any]] = None
    skills: Optional[List[str]] = None
    preload_skills: Optional[List[str]] = None  # Skills to preload into system prompt
    namespace: Optional[str] = None  # Namespace for the bot (group name or 'default')
    is_active: Optional[bool] = None


class BotInDB(BaseModel):
    """Database bot model - response schema"""

    id: int
    user_id: int
    name: str
    namespace: Optional[str] = (
        "default"  # Namespace for group bots (default: 'default')
    )
    shell_name: str  # Shell name (the name user selected, e.g., 'ClaudeCode', 'my-custom-shell')
    shell_type: str  # Actual agent type (e.g., 'ClaudeCode', 'Agno', 'Dify')
    agent_config: dict[str, Any]
    system_prompt: Optional[str] = None
    mcp_servers: Optional[dict[str, Any]] = None
    skills: Optional[List[str]] = None
    preload_skills: Optional[List[str]] = None  # Skills to preload into system prompt
    is_active: bool = True
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class BotDetail(BaseModel):
    """Detailed bot model with related entities"""

    id: int
    name: str
    namespace: Optional[str] = (
        "default"  # Namespace for group bots (default: 'default')
    )
    shell_name: str  # Shell name (the name user selected, e.g., 'ClaudeCode', 'my-custom-shell')
    shell_type: str  # Actual agent type (e.g., 'ClaudeCode', 'Agno', 'Dify')
    agent_config: dict[str, Any]
    system_prompt: Optional[str] = None
    mcp_servers: Optional[dict[str, Any]] = None
    skills: Optional[List[str]] = None
    preload_skills: Optional[List[str]] = None  # Skills to preload into system prompt
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
