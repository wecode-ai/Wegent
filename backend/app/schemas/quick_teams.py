# SPDX-FileCopyrightText: 2025 WeCode, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Schemas for quick team configuration
"""
from typing import Dict, List, Optional

from pydantic import BaseModel


class QuickTeamItem(BaseModel):
    """Single quick team configuration item"""

    team_id: int
    icon: str = "Users"
    sort_order: int = 0


class QuickTeamsConfig(BaseModel):
    """Quick teams configuration for different scenes"""

    chat: List[QuickTeamItem] = []
    code: List[QuickTeamItem] = []


class QuickTeamResponse(BaseModel):
    """Quick team response with full team info"""

    team_id: int
    team_name: str
    team_namespace: str
    description: Optional[str] = None
    icon: str
    sort_order: int


class QuickTeamsListResponse(BaseModel):
    """Response for quick teams list"""

    items: List[QuickTeamResponse]


class SystemConfigResponse(BaseModel):
    """Response for system config"""

    config_key: str
    config_value: Dict
