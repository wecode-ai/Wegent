# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from datetime import datetime
from typing import Any, Optional

from pydantic import BaseModel


class AgentBase(BaseModel):
    """Agent base schema"""

    name: str
    config: Optional[dict[str, Any]] = None


class AgentCreate(AgentBase):
    """Agent creation schema"""

    pass


class AgentUpdate(BaseModel):
    """Agent update schema"""

    name: Optional[str] = None
    config: Optional[dict[str, Any]] = None


class AgentInDB(AgentBase):
    """Database agent schema"""

    id: int
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class AgentDetail(BaseModel):
    """Detailed agent schema"""

    id: int
    name: str
    config: dict[str, Any]
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class AgentListResponse(BaseModel):
    """Agent paginated response schema"""

    total: int
    items: list[AgentInDB]
