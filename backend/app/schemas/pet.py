# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Pet schemas for API request/response models."""

from datetime import date, datetime
from typing import Any, Dict, Literal, Optional

from pydantic import BaseModel, Field


class AppearanceTraits(BaseModel):
    """Appearance traits based on user's memory analysis."""

    primary_domain: Optional[str] = Field(
        default="general",
        description="Primary domain detected from user memories",
    )
    secondary_domain: Optional[str] = Field(
        default=None,
        description="Secondary domain detected from user memories",
    )
    color_tone: Optional[str] = Field(
        default="gray",
        description="Color tone based on primary domain",
    )
    accessories: Optional[list[str]] = Field(
        default_factory=list,
        description="List of accessory elements based on domains",
    )


class PetBase(BaseModel):
    """Base pet model with common fields."""

    pet_name: str = Field(
        default="Wegi",
        min_length=1,
        max_length=50,
        description="Pet name",
    )
    is_visible: bool = Field(
        default=True,
        description="Whether pet widget is visible",
    )


class PetCreate(PetBase):
    """Schema for creating a new pet (internal use)."""

    svg_seed: str = Field(
        ...,
        description="SVG generation seed",
    )


class PetUpdate(BaseModel):
    """Schema for updating pet settings."""

    pet_name: Optional[str] = Field(
        default=None,
        min_length=1,
        max_length=50,
        description="New pet name",
    )
    is_visible: Optional[bool] = Field(
        default=None,
        description="Whether pet widget is visible",
    )


class PetResponse(PetBase):
    """Response schema for pet data."""

    id: int
    user_id: int
    stage: int = Field(
        ge=1,
        le=3,
        description="Evolution stage: 1=baby, 2=growing, 3=mature",
    )
    experience: int = Field(
        ge=0,
        description="Current experience points",
    )
    total_chats: int = Field(
        ge=0,
        description="Total chat messages sent",
    )
    current_streak: int = Field(
        ge=0,
        description="Current consecutive usage days",
    )
    longest_streak: int = Field(
        ge=0,
        description="Longest consecutive usage days",
    )
    last_active_date: Optional[date] = Field(
        default=None,
        description="Last active date",
    )
    appearance_traits: Dict[str, Any] = Field(
        default_factory=dict,
        description="Appearance traits based on memory analysis",
    )
    svg_seed: str = Field(
        description="SVG generation seed for consistent appearance",
    )
    experience_to_next_stage: Optional[int] = Field(
        default=None,
        description="Experience needed to reach next stage (None if at max stage)",
    )
    streak_multiplier: float = Field(
        default=1.0,
        description="Current experience multiplier based on streak",
    )
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class PetStatsResponse(BaseModel):
    """Response schema for pet statistics."""

    total_chats: int
    current_streak: int
    longest_streak: int
    experience: int
    stage: int
    stage_name: str
    experience_to_next_stage: Optional[int]
    streak_multiplier: float


class ExperienceGainedEvent(BaseModel):
    """WebSocket event payload for experience gained."""

    amount: int = Field(
        description="Amount of experience gained",
    )
    total: int = Field(
        description="Total experience after gain",
    )
    source: Literal["chat", "streak_bonus"] = Field(
        description="Source of experience gain",
    )
    multiplier: float = Field(
        default=1.0,
        description="Multiplier applied to the base experience",
    )


class StageEvolvedEvent(BaseModel):
    """WebSocket event payload for stage evolution."""

    old_stage: int = Field(
        ge=1,
        le=3,
        description="Previous evolution stage",
    )
    new_stage: int = Field(
        ge=1,
        le=3,
        description="New evolution stage",
    )
    old_stage_name: str = Field(
        description="Previous stage name",
    )
    new_stage_name: str = Field(
        description="New stage name",
    )


class TraitsUpdatedEvent(BaseModel):
    """WebSocket event payload for traits update."""

    traits: Dict[str, Any] = Field(
        description="Updated appearance traits",
    )


# Domain to appearance mapping
DOMAIN_APPEARANCE_MAP = {
    "legal": {
        "color_tone": "navy",
        "accessories": ["bowtie", "briefcase", "scales"],
    },
    "tech": {
        "color_tone": "teal",
        "accessories": ["glasses", "code_symbol", "gear"],
    },
    "design": {
        "color_tone": "purple",
        "accessories": ["paintbrush", "palette"],
    },
    "finance": {
        "color_tone": "gold",
        "accessories": ["tie", "chart"],
    },
    "medical": {
        "color_tone": "blue",
        "accessories": ["stethoscope", "heart"],
    },
    "education": {
        "color_tone": "green",
        "accessories": ["book", "graduation_cap"],
    },
    "general": {
        "color_tone": "gray",
        "accessories": [],
    },
}

# Stage names for i18n reference
STAGE_NAMES = {
    1: "baby",
    2: "growing",
    3: "mature",
}
