# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Session model for IM integration.

Sessions track the mapping between IM conversations and Wegent Tasks,
enabling continuous conversation context.
"""

from datetime import datetime
from typing import Dict, Optional

from pydantic import BaseModel

from app.services.im.base.message import IMPlatform


class IMSession(BaseModel):
    """
    IM session model.

    Tracks the mapping between an IM conversation and a Wegent Task,
    allowing for conversation continuity.
    """

    platform: IMPlatform
    platform_user_id: str  # Platform-specific user ID
    platform_chat_id: str  # Platform-specific chat ID
    team_id: int  # Wegent Team ID
    task_id: Optional[int] = None  # Associated Wegent Task ID
    last_activity: datetime  # Last message timestamp
    metadata: Dict = {}  # Platform-specific metadata
