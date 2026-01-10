# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Marketplace schemas for Agent Marketplace feature.

This module defines the Pydantic schemas for:
- Marketplace team listing and detail responses
- Installation/uninstallation requests
- Admin publishing requests
"""

from datetime import datetime
from enum import Enum
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field


class MarketplaceCategory(str, Enum):
    """Predefined categories for marketplace teams"""

    DEVELOPMENT = "development"
    OFFICE = "office"
    CREATIVE = "creative"
    DATA_ANALYSIS = "data_analysis"
    EDUCATION = "education"
    OTHER = "other"


class InstallMode(str, Enum):
    """Installation modes for marketplace teams"""

    REFERENCE = "reference"
    COPY = "copy"


# ==================== Request Schemas ====================


class InstallTeamRequest(BaseModel):
    """Request schema for installing a marketplace team"""

    mode: InstallMode = Field(
        default=InstallMode.REFERENCE, description="Installation mode"
    )


class PublishTeamRequest(BaseModel):
    """Request schema for publishing a team to marketplace (admin only)"""

    team_id: int = Field(..., description="Team ID to publish (must be user_id=0)")
    category: MarketplaceCategory = Field(
        default=MarketplaceCategory.OTHER, description="Marketplace category"
    )
    description: Optional[str] = Field(
        None, description="Marketplace display description"
    )
    icon: Optional[str] = Field(None, description="Marketplace display icon")
    allow_reference: bool = Field(True, description="Allow reference mode installation")
    allow_copy: bool = Field(True, description="Allow copy mode installation")


class UpdateMarketplaceTeamRequest(BaseModel):
    """Request schema for updating marketplace team info (admin only)"""

    category: Optional[MarketplaceCategory] = Field(None, description="Category")
    description: Optional[str] = Field(None, description="Description")
    icon: Optional[str] = Field(None, description="Icon")
    allow_reference: Optional[bool] = Field(None, description="Allow reference mode")
    allow_copy: Optional[bool] = Field(None, description="Allow copy mode")
    is_active: Optional[bool] = Field(None, description="Is active/published")


# ==================== Response Schemas ====================


class MarketplaceTeamBase(BaseModel):
    """Base schema for marketplace team"""

    id: int
    team_id: int
    name: str
    category: str
    description: Optional[str] = None
    icon: Optional[str] = None
    allow_reference: bool = True
    allow_copy: bool = True
    install_count: int = 0
    is_active: bool = True
    published_at: Optional[datetime] = None


class MarketplaceTeamListItem(MarketplaceTeamBase):
    """Schema for marketplace team list item"""

    # Extended fields from Team CRD
    bind_mode: Optional[List[str]] = None
    agent_type: Optional[str] = None
    bots_count: int = 0

    # User installation status
    is_installed: bool = False
    installed_mode: Optional[str] = None

    class Config:
        from_attributes = True


class MarketplaceTeamDetail(MarketplaceTeamListItem):
    """Schema for marketplace team detail"""

    # Full team data
    team_data: Optional[Dict[str, Any]] = None
    # Bot details
    bots: Optional[List[Dict[str, Any]]] = None

    class Config:
        from_attributes = True


class MarketplaceTeamListResponse(BaseModel):
    """Response schema for marketplace team list"""

    total: int
    items: List[MarketplaceTeamListItem]


class InstalledTeamBase(BaseModel):
    """Base schema for installed team"""

    id: int
    user_id: int
    marketplace_team_id: int
    install_mode: str
    copied_team_id: Optional[int] = None
    is_active: bool = True
    installed_at: datetime
    uninstalled_at: Optional[datetime] = None


class InstalledTeamResponse(InstalledTeamBase):
    """Response schema for installed team"""

    # Extended marketplace team info
    marketplace_team: Optional[MarketplaceTeamListItem] = None

    class Config:
        from_attributes = True


class InstalledTeamListResponse(BaseModel):
    """Response schema for installed team list"""

    total: int
    items: List[InstalledTeamResponse]


class InstallTeamResponse(BaseModel):
    """Response schema for install operation"""

    success: bool
    message: str
    installed_team_id: int
    install_mode: str
    # For copy mode, the new team ID in user space
    copied_team_id: Optional[int] = None


class UninstallTeamResponse(BaseModel):
    """Response schema for uninstall operation"""

    success: bool
    message: str


class CategoryItem(BaseModel):
    """Schema for category list item"""

    value: str
    label: str
    count: int = 0


class CategoryListResponse(BaseModel):
    """Response schema for category list"""

    categories: List[CategoryItem]


# ==================== Admin Response Schemas ====================


class AdminMarketplaceTeamResponse(MarketplaceTeamDetail):
    """Response schema for admin marketplace team (includes all fields)"""

    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class AdminMarketplaceTeamListResponse(BaseModel):
    """Response schema for admin marketplace team list"""

    total: int
    items: List[AdminMarketplaceTeamResponse]
