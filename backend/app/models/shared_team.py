# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from datetime import datetime

from sqlalchemy import Boolean, Column, DateTime, ForeignKey, Index, Integer
from sqlalchemy.orm import relationship

from app.db.base import Base


class SharedTeam(Base):
    """Shared team model for maintaining user-team sharing relationships"""

    __tablename__ = "shared_teams"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(
        Integer, nullable=False, index=True
    )  # User who joined the shared team
    original_user_id = Column(
        Integer, nullable=False, index=True
    )  # Original user who created the team
    team_id = Column(Integer, nullable=False, index=True)  # Team that was shared
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime, default=datetime.now)
    updated_at = Column(DateTime, default=datetime.now, onupdate=datetime.now)

    __table_args__ = (
        Index("idx_user_team", "user_id", "team_id", unique=True),
        {"mysql_charset": "utf8mb4", "mysql_collate": "utf8mb4_unicode_ci"},
    )
