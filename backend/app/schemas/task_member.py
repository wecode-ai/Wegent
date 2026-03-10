# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Schemas for task member (group chat) functionality.
"""

from datetime import datetime
from enum import Enum
from typing import List, Optional

from pydantic import BaseModel


class MemberStatus(str, Enum):
    """Status of a task member"""

    ACTIVE = "ACTIVE"
    REMOVED = "REMOVED"


class AddMemberRequest(BaseModel):
    """Request to add a member to a task"""

    user_id: int


class TaskMemberResponse(BaseModel):
    """Response for a single task member"""

    id: int
    task_id: int
    user_id: int
    username: str
    avatar: Optional[str] = None
    invited_by: int
    inviter_name: str
    status: MemberStatus
    joined_at: datetime
    is_owner: bool  # Whether this member is the task creator

    class Config:
        from_attributes = True


class TaskMemberListResponse(BaseModel):
    """Response for list of task members"""

    members: List[TaskMemberResponse]
    total: int
    task_owner_id: int


class RemoveMemberResponse(BaseModel):
    """Response for member removal"""

    message: str
    user_id: int
