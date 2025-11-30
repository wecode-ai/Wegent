# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from datetime import datetime

from sqlalchemy import Column, DateTime, Index, Integer

from app.db.base import Base


class UserTeamFavorite(Base):
    """User team favorite model for maintaining user-team favorite relationships"""

    __tablename__ = "user_team_favorites"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, nullable=False, index=True)  # User who favorited the team
    team_id = Column(Integer, nullable=False, index=True)  # Team that was favorited
    created_at = Column(DateTime, default=datetime.now)

    __table_args__ = (
        Index("idx_user_team_favorite", "user_id", "team_id", unique=True),
        {"mysql_charset": "utf8mb4", "mysql_collate": "utf8mb4_unicode_ci"},
    )
