# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Pet database model for user pet nurturing feature.

Each user can have one pet that grows with their AI usage.
"""
from datetime import date, datetime

from sqlalchemy import (
    JSON,
    Boolean,
    Column,
    Date,
    DateTime,
    ForeignKey,
    Integer,
    String,
)
from sqlalchemy.orm import relationship

from app.db.base import Base


class UserPet(Base):
    """
    UserPet model for storing user pet data.

    Pet evolves through stages based on user's AI usage:
    - Stage 1 (Baby): 0-99 experience
    - Stage 2 (Growing): 100-499 experience
    - Stage 3 (Mature): 500+ experience
    """

    __tablename__ = "user_pets"

    id = Column(Integer, primary_key=True, index=True, comment="Primary key")
    user_id = Column(
        Integer,
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        unique=True,
        index=True,
        comment="User ID, references users.id",
    )
    pet_name = Column(
        String(50),
        nullable=False,
        default="Buddy",
        comment="Pet name (user customizable)",
    )
    stage = Column(
        Integer,
        nullable=False,
        default=1,
        comment="Evolution stage: 1=baby, 2=growing, 3=mature",
    )
    experience = Column(
        Integer,
        nullable=False,
        default=0,
        comment="Current experience points",
    )
    total_chats = Column(
        Integer,
        nullable=False,
        default=0,
        comment="Total chat messages sent",
    )
    total_memories = Column(
        Integer,
        nullable=False,
        default=0,
        comment="Total long-term memories stored",
    )
    current_streak = Column(
        Integer,
        nullable=False,
        default=0,
        comment="Current consecutive usage days",
    )
    longest_streak = Column(
        Integer,
        nullable=False,
        default=0,
        comment="Longest consecutive usage days",
    )
    last_active_date = Column(
        Date,
        nullable=True,
        comment="Last active date for streak calculation",
    )
    appearance_traits = Column(
        JSON,
        nullable=False,
        default=dict,
        comment="Appearance traits based on memory analysis (JSON)",
    )
    svg_seed = Column(
        String(64),
        nullable=False,
        comment="SVG generation seed for consistent appearance",
    )
    is_visible = Column(
        Boolean,
        nullable=False,
        default=True,
        comment="Whether pet widget is visible",
    )
    created_at = Column(
        DateTime,
        nullable=False,
        default=datetime.now,
        comment="Creation time",
    )
    updated_at = Column(
        DateTime,
        nullable=False,
        default=datetime.now,
        onupdate=datetime.now,
        comment="Update time",
    )

    # Relationship to User
    user = relationship("User", backref="pet", uselist=False)

    __table_args__ = (
        {"mysql_charset": "utf8mb4", "mysql_collate": "utf8mb4_unicode_ci"},
    )

    # Experience thresholds for evolution
    STAGE_THRESHOLDS = {
        1: 0,      # Baby: 0-99
        2: 100,    # Growing: 100-499
        3: 500,    # Mature: 500+
    }

    # Streak multipliers
    STREAK_MULTIPLIERS = {
        3: 1.1,   # 3+ days: 10% bonus
        7: 1.2,   # 7+ days: 20% bonus
        30: 1.5,  # 30+ days: 50% bonus
    }

    def calculate_stage(self) -> int:
        """Calculate the current stage based on experience."""
        if self.experience >= self.STAGE_THRESHOLDS[3]:
            return 3
        elif self.experience >= self.STAGE_THRESHOLDS[2]:
            return 2
        return 1

    def get_streak_multiplier(self) -> float:
        """Get the experience multiplier based on current streak."""
        if self.current_streak >= 30:
            return self.STREAK_MULTIPLIERS[30]
        elif self.current_streak >= 7:
            return self.STREAK_MULTIPLIERS[7]
        elif self.current_streak >= 3:
            return self.STREAK_MULTIPLIERS[3]
        return 1.0
