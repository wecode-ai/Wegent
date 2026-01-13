# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Marketplace models for Agent Marketplace feature.

This module defines the database models for:
- TeamMarketplace: Extended information for marketplace teams (user_id=0)
- InstalledTeam: User installation records for marketplace teams
"""

from datetime import datetime
from enum import Enum

from sqlalchemy import Boolean, Column, DateTime, Index, Integer, String, Text

from app.db.base import Base


class MarketplaceCategory(str, Enum):
    """Predefined categories for marketplace teams"""

    DEVELOPMENT = "development"  # Development tools
    OFFICE = "office"  # Office productivity
    CREATIVE = "creative"  # Creative tools
    DATA_ANALYSIS = "data_analysis"  # Data analysis
    EDUCATION = "education"  # Education
    OTHER = "other"  # Other


class InstallMode(str, Enum):
    """Installation modes for marketplace teams"""

    REFERENCE = "reference"  # Direct reference, cannot modify
    COPY = "copy"  # Copy to user space, can modify


class TeamMarketplace(Base):
    """
    Extended information for marketplace teams.

    Marketplace teams are teams with user_id=0 that are published
    to the marketplace for all users to browse and install.
    """

    __tablename__ = "team_marketplace"

    id = Column(Integer, primary_key=True, index=True)
    team_id = Column(Integer, nullable=False, unique=True)  # Reference to kinds.id
    category = Column(
        String(50), nullable=False, default=MarketplaceCategory.OTHER.value
    )
    description = Column(Text, nullable=True)  # Marketplace display description
    icon = Column(String(100), nullable=True)  # Marketplace display icon
    allow_reference = Column(Boolean, default=True)  # Allow reference mode
    allow_copy = Column(Boolean, default=True)  # Allow copy mode
    install_count = Column(Integer, default=0)  # Installation count for statistics
    is_active = Column(Boolean, default=True)  # Is published/active
    published_at = Column(DateTime, nullable=True)  # Publish time
    created_at = Column(DateTime, default=datetime.now)
    updated_at = Column(DateTime, default=datetime.now, onupdate=datetime.now)

    __table_args__ = (
        Index("idx_tm_category", "category"),
        Index("idx_tm_is_active", "is_active"),
        {
            "mysql_engine": "InnoDB",
            "mysql_charset": "utf8mb4",
            "mysql_collate": "utf8mb4_unicode_ci",
        },
    )


class InstalledTeam(Base):
    """
    User installation records for marketplace teams.

    Tracks which marketplace teams each user has installed,
    the installation mode (reference or copy), and the copied
    team ID if using copy mode.
    """

    __tablename__ = "installed_teams"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, nullable=False, index=True)  # Installing user
    marketplace_team_id = Column(
        Integer, nullable=False
    )  # Reference to team_marketplace.id
    install_mode = Column(
        String(20), nullable=False, default=InstallMode.REFERENCE.value
    )
    copied_team_id = Column(
        Integer, nullable=True
    )  # Team ID in user space for copy mode
    is_active = Column(Boolean, default=True)  # Is active (false when uninstalled)
    installed_at = Column(DateTime, default=datetime.now)
    uninstalled_at = Column(DateTime, nullable=True)

    __table_args__ = (
        Index(
            "uk_it_user_marketplace",
            "user_id",
            "marketplace_team_id",
            unique=True,
        ),
        Index("idx_it_user_id", "user_id"),
        Index("idx_it_is_active", "is_active"),
        {
            "mysql_engine": "InnoDB",
            "mysql_charset": "utf8mb4",
            "mysql_collate": "utf8mb4_unicode_ci",
        },
    )
