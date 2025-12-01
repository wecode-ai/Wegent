# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from typing import Any, Dict, List, Set

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.user_team_favorite import UserTeamFavorite


class TeamFavoriteService:
    """Service for team favorite operations"""

    def add_favorite(
        self, db: Session, *, team_id: int, user_id: int
    ) -> Dict[str, Any]:
        """Add a team to user's favorites"""
        # Check if team exists
        team = (
            db.query(Kind)
            .filter(Kind.id == team_id, Kind.kind == "Team", Kind.is_active == True)
            .first()
        )

        if not team:
            raise HTTPException(status_code=404, detail="Team not found")

        # Check if already favorited
        existing = (
            db.query(UserTeamFavorite)
            .filter(
                UserTeamFavorite.user_id == user_id, UserTeamFavorite.team_id == team_id
            )
            .first()
        )

        if existing:
            return {"message": "Team already in favorites", "is_favorited": True}

        # Create favorite record
        favorite = UserTeamFavorite(user_id=user_id, team_id=team_id)
        db.add(favorite)
        db.commit()

        return {"message": "Team added to favorites", "is_favorited": True}

    def remove_favorite(
        self, db: Session, *, team_id: int, user_id: int
    ) -> Dict[str, Any]:
        """Remove a team from user's favorites"""
        favorite = (
            db.query(UserTeamFavorite)
            .filter(
                UserTeamFavorite.user_id == user_id, UserTeamFavorite.team_id == team_id
            )
            .first()
        )

        if not favorite:
            return {"message": "Team not in favorites", "is_favorited": False}

        db.delete(favorite)
        db.commit()

        return {"message": "Team removed from favorites", "is_favorited": False}

    def get_user_favorite_team_ids(self, db: Session, *, user_id: int) -> Set[int]:
        """Get set of team IDs that user has favorited"""
        favorites = (
            db.query(UserTeamFavorite.team_id)
            .filter(UserTeamFavorite.user_id == user_id)
            .all()
        )
        return {f.team_id for f in favorites}

    def is_team_favorited(self, db: Session, *, team_id: int, user_id: int) -> bool:
        """Check if a team is in user's favorites"""
        favorite = (
            db.query(UserTeamFavorite)
            .filter(
                UserTeamFavorite.user_id == user_id, UserTeamFavorite.team_id == team_id
            )
            .first()
        )
        return favorite is not None


team_favorite_service = TeamFavoriteService()
