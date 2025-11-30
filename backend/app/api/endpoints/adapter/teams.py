# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from typing import Any, Dict, List

from fastapi import APIRouter, Depends, Query, status
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core import security
from app.models.kind import Kind
from app.models.user import User
from app.schemas.shared_team import (
    JoinSharedTeamRequest,
    JoinSharedTeamResponse,
    TeamShareRequest,
    TeamShareResponse,
)
from app.schemas.team import (
    TeamCreate,
    TeamDetail,
    TeamInDB,
    TeamListResponse,
    TeamUpdate,
)
from app.services.adapters.team_kinds import team_kinds_service
from app.services.shared_team import shared_team_service
from app.services.team_favorite import team_favorite_service

router = APIRouter()


@router.get("", response_model=TeamListResponse)
def list_teams(
    page: int = Query(1, ge=1, description="Page number"),
    limit: int = Query(10, ge=1, le=100, description="Items per page"),
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """Get current user's Team list (paginated)"""
    skip = (page - 1) * limit
    items = team_kinds_service.get_user_teams(
        db=db, user_id=current_user.id, skip=skip, limit=limit
    )

    # Add is_favorited field to each team
    favorite_team_ids = team_favorite_service.get_user_favorite_team_ids(
        db=db, user_id=current_user.id
    )
    for item in items:
        item["is_favorited"] = item["id"] in favorite_team_ids

    if page == 1 and len(items) < limit:
        total = len(items)
    else:
        total = team_kinds_service.count_user_teams(db=db, user_id=current_user.id)
    return {"total": total, "items": items}


@router.post("", response_model=TeamInDB, status_code=status.HTTP_201_CREATED)
def create_team(
    team_create: TeamCreate,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """Create new Team"""
    return team_kinds_service.create_with_user(
        db=db, obj_in=team_create, user_id=current_user.id
    )


@router.get("/{team_id}", response_model=TeamDetail)
def get_team(
    team_id: int,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """Get specified Team details with related user and bots"""
    return team_kinds_service.get_team_detail(
        db=db, team_id=team_id, user_id=current_user.id
    )


@router.put("/{team_id}", response_model=TeamInDB)
def update_team(
    team_id: int,
    team_update: TeamUpdate,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """Update Team information"""
    return team_kinds_service.update_with_user(
        db=db, team_id=team_id, obj_in=team_update, user_id=current_user.id
    )


@router.delete("/{team_id}")
def delete_team(
    team_id: int,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    team_kinds_service.delete_with_user(db=db, team_id=team_id, user_id=current_user.id)
    return {"message": "Team deactivated successfully"}


@router.post("/{team_id}/share", response_model=TeamShareResponse)
def share_team(
    team_id: int,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """Generate team share link"""
    return shared_team_service.share_team(
        db=db,
        team_id=team_id,
        user_id=current_user.id,
    )


@router.get("/{team_id}/input-parameters")
def get_team_input_parameters(
    team_id: int,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """Get input parameters required by the team's external API bots"""
    return team_kinds_service.get_team_input_parameters(
        db=db, team_id=team_id, user_id=current_user.id
    )


@router.get("/share/info")
def get_share_info(
    share_token: str = Query(..., description="Share token"),
    db: Session = Depends(get_db),
):
    """Get team share information from token"""
    return shared_team_service.get_share_info(db=db, share_token=share_token)


@router.post("/share/join", response_model=JoinSharedTeamResponse)
def join_shared_team(
    request: JoinSharedTeamRequest,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """Join a shared team"""
    return shared_team_service.join_shared_team(
        db=db, share_token=request.share_token, user_id=current_user.id
    )


@router.post("/{team_id}/favorite")
def add_team_to_favorites(
    team_id: int,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """Add a team to user's favorites"""
    return team_favorite_service.add_favorite(
        db=db, team_id=team_id, user_id=current_user.id
    )


@router.delete("/{team_id}/favorite")
def remove_team_from_favorites(
    team_id: int,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """Remove a team from user's favorites"""
    return team_favorite_service.remove_favorite(
        db=db, team_id=team_id, user_id=current_user.id
    )


@router.get("/showcase/recommended", response_model=List[Dict[str, Any]])
def get_recommended_teams(
    limit: int = Query(6, ge=1, le=20, description="Max teams to return"),
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """Get recommended teams (is_recommended=true)"""
    from app.schemas.kind import Team

    # Get all teams where isRecommended is true
    teams = db.query(Kind).filter(Kind.kind == "Team", Kind.is_active == True).all()

    recommended_teams = []
    favorite_team_ids = team_favorite_service.get_user_favorite_team_ids(
        db=db, user_id=current_user.id
    )

    for team in teams:
        team_crd = Team.model_validate(team.json)
        if team_crd.spec.isRecommended:
            team_dict = team_kinds_service._convert_to_team_dict(team, db, team.user_id)
            team_dict["is_favorited"] = team.id in favorite_team_ids
            recommended_teams.append(team_dict)
            if len(recommended_teams) >= limit:
                break

    return recommended_teams


@router.get("/showcase/favorites", response_model=List[Dict[str, Any]])
def get_favorite_teams(
    limit: int = Query(6, ge=1, le=20, description="Max teams to return"),
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """Get user's favorite teams"""
    from app.models.user_team_favorite import UserTeamFavorite

    # Get user's favorite team IDs
    favorites = (
        db.query(UserTeamFavorite)
        .filter(UserTeamFavorite.user_id == current_user.id)
        .order_by(UserTeamFavorite.created_at.desc())
        .limit(limit)
        .all()
    )

    favorite_teams = []
    for favorite in favorites:
        team = (
            db.query(Kind)
            .filter(
                Kind.id == favorite.team_id,
                Kind.kind == "Team",
                Kind.is_active == True,
            )
            .first()
        )

        if team:
            team_dict = team_kinds_service._convert_to_team_dict(team, db, team.user_id)
            team_dict["is_favorited"] = True
            favorite_teams.append(team_dict)

    return favorite_teams
