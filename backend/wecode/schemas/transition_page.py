"""
Transition Page Schemas
"""

from datetime import datetime
from enum import Enum
from typing import Any, Optional

from pydantic import BaseModel, Field


class BlockStage(str, Enum):
    """Block display stage"""

    ALWAYS = "always"
    BEFORE = "before"
    ACTIVE = "active"
    AFTER = "after"


class ButtonVariant(str, Enum):
    """Button variant"""

    PRIMARY = "primary"
    SECONDARY = "secondary"
    OUTLINE = "outline"
    GHOST = "ghost"


class BlockCondition(BaseModel):
    """Block visibility condition"""

    groups: Optional[list[str]] = Field(None)
    users: Optional[list[str]] = Field(None)


class BlockButton(BaseModel):
    """Block button"""

    label: str
    url_template: str
    variant: ButtonVariant = ButtonVariant.PRIMARY
    target: str = "_blank"


class TitleFontSize(str, Enum):
    """Title font size options"""

    SMALL = "small"  # text-lg
    MEDIUM = "medium"  # text-xl
    LARGE = "large"  # text-2xl (default)
    XLARGE = "xlarge"  # text-3xl


class BlockData(BaseModel):
    """Block data structure"""

    title: str
    title_font_size: TitleFontSize = TitleFontSize.LARGE
    icon: Optional[str] = None
    stage: BlockStage = BlockStage.ALWAYS
    start_at: Optional[str] = None
    end_at: Optional[str] = None
    condition: BlockCondition = Field(default_factory=lambda: BlockCondition())
    markdown_template: str
    buttons: list[BlockButton] = Field(default_factory=list)
    freeze_enabled: bool = False  # Enable freeze mode - once viewed, always visible
    block_group_key: Optional[str] = None  # Associated block group key for mutex grouping


class GroupData(BaseModel):
    """Group data structure"""

    name: str
    start_at: Optional[str] = None
    end_at: Optional[str] = None
    content: Optional[dict[str, Any]] = None


class BlockGroupData(BaseModel):
    """Block group data structure for mutex grouping"""

    name: str
    mutex: bool = False  # If true, viewing any block in group freezes entire group


class BlockGroupCreateRequest(BaseModel):
    """Create block group request"""

    key: str
    data: BlockGroupData


class BlockGroupUpdateRequest(BaseModel):
    """Update block group request"""

    data: BlockGroupData


class TransitionPageCreate(BaseModel):
    """Create transition page"""

    title: str
    slug: str


class TransitionPageUpdate(BaseModel):
    """Update transition page"""

    title: Optional[str] = None
    status: Optional[str] = None
    title_font_size: Optional[str] = None


class BlockCreateRequest(BaseModel):
    """Create block request"""

    key: str
    data: BlockData
    sort_order: Optional[int] = 0


class BlockUpdateRequest(BaseModel):
    """Update block request"""

    data: Optional[BlockData] = None
    sort_order: Optional[int] = None


class GroupCreateRequest(BaseModel):
    """Create group request"""

    key: str
    data: GroupData


class GroupUpdateRequest(BaseModel):
    """Update group request"""

    data: GroupData


class UserImportResponse(BaseModel):
    """Import users response"""

    total: int
    success: int
    failed: int
    errors: list[str]


class RenderedButton(BaseModel):
    """Rendered button"""

    label: str
    url: str
    variant: str
    target: str


class RenderedBlock(BaseModel):
    """Rendered block"""

    title: str
    icon: Optional[str] = None
    markdown: str
    buttons: list[RenderedButton]


class RenderedPage(BaseModel):
    """Rendered page info"""

    title: str
    slug: str
    title_font_size: Optional[str] = None


class RenderedPageResponse(BaseModel):
    """Rendered page response"""

    page: RenderedPage
    group: Optional[dict[str, Any]]
    blocks: list[RenderedBlock]


class TransitionPageListItem(BaseModel):
    """Transition page list item"""

    page_id: str
    slug: str
    title: str
    status: str
    created_at: datetime
    updated_at: datetime


class GroupMemberInfo(BaseModel):
    """Group member info"""

    email: str
    group_key: str


class TransitionPageDetail(BaseModel):
    """Transition page detail with all items"""

    page_id: str
    slug: str
    title: str
    status: str
    title_font_size: Optional[str] = None
    groups: list[dict[str, Any]]
    block_groups: list[dict[str, Any]] = []
    blocks: list[dict[str, Any]]
    members: list[GroupMemberInfo]
    created_at: datetime
    updated_at: datetime


class TransitionPageItemResponse(BaseModel):
    """Transition page item response"""

    page_id: str
    type: str
    key: str
    data_json: dict[str, Any]
    sort_order: int
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True
