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
from app.services.adapters.team_kinds import team_kinds_service

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
    """Soft delete Team (set is_active to False)"""
    team_kinds_service.delete_with_user(db=db, team_id=team_id, user_id=current_user.id)
    return {"message": "Team deactivated successfully"}