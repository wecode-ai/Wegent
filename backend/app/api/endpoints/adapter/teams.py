# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from fastapi import APIRouter, Depends, Query, status
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core import security
from app.models.user import User
from app.models.kind import Kind
from app.schemas.team import TeamCreate, TeamUpdate, TeamInDB, TeamListResponse, TeamDetail
from app.schemas.shared_team import TeamShareRequest, TeamShareResponse, JoinSharedTeamRequest, JoinSharedTeamResponse
from app.services.adapters.team_kinds import team_kinds_service
from app.services.shared_team import shared_team_service

router = APIRouter()

@router.get("", response_model=TeamListResponse)
def list_teams(
    page: int = Query(1, ge=1, description="Page number"),
    limit: int = Query(10, ge=1, le=100, description="Items per page"),
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user)
):
    """Get current user's Team list (paginated)"""
    skip = (page - 1) * limit
    items = team_kinds_service.get_user_teams(
        db=db,
        user_id=current_user.id,
        skip=skip,
        limit=limit
    )
    if page == 1 and len(items) < limit:
        total = len(items)
    else:
        total = team_kinds_service.count_user_teams(db=db, user_id=current_user.id)
    return {"total": total, "items": items}

@router.post("", response_model=TeamInDB, status_code=status.HTTP_201_CREATED)
def create_team(
    team_create: TeamCreate,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db)
):
    """Create new Team"""
    return team_kinds_service.create_with_user(db=db, obj_in=team_create, user_id=current_user.id)

@router.get("/{team_id}", response_model=TeamDetail)
def get_team(
    team_id: int,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db)
):
    """Get specified Team details with related user and bots"""
    return team_kinds_service.get_team_detail(db=db, team_id=team_id, user_id=current_user.id)

@router.put("/{team_id}", response_model=TeamInDB)
def update_team(
    team_id: int,
    team_update: TeamUpdate,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db)
):
    """Update Team information"""
    return team_kinds_service.update_with_user(
        db=db,
        team_id=team_id,
        obj_in=team_update,
        user_id=current_user.id
    )

@router.delete("/{team_id}")
def delete_team(
    team_id: int,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db)
):
    team_kinds_service.delete_with_user(db=db, team_id=team_id, user_id=current_user.id)
    return {"message": "Team deactivated successfully"}

@router.post("/{team_id}/share", response_model=TeamShareResponse)
def share_team(
    team_id: int,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db)
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
    db: Session = Depends(get_db)
):
    """Get input parameters required by the team's external API bots"""
    return team_kinds_service.get_team_input_parameters(
        db=db,
        team_id=team_id,
        user_id=current_user.id
    )

@router.get("/share/info")
def get_share_info(
    share_token: str = Query(..., description="Share token"),
    db: Session = Depends(get_db)
):
    """Get team share information from token"""
    return shared_team_service.get_share_info(db=db, share_token=share_token)

@router.post("/share/join", response_model=JoinSharedTeamResponse)
def join_shared_team(
    request: JoinSharedTeamRequest,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db)
):
    """Join a shared team"""
    return shared_team_service.join_shared_team(
        db=db,
        share_token=request.share_token,
        user_id=current_user.id
    )