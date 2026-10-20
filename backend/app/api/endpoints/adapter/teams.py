# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import logging
from typing import Optional

from fastapi import APIRouter, Depends, Query, status
from sqlalchemy.orm import Session

logger = logging.getLogger(__name__)

from app.api.dependencies import get_db
from app.core import security
from app.models.user import User
from app.schemas.shared_team import (
    JoinSharedTeamRequest,
    JoinSharedTeamResponse,
    TeamShareResponse,
)
from app.schemas.team import (
    TeamCreate,
    TeamDetail,
    TeamInDB,
    TeamUpdate,
)
from app.services.adapters.team_kinds import team_kinds_service
from app.services.shared_team import shared_team_service

router = APIRouter()


@router.post("", response_model=TeamInDB, status_code=status.HTTP_201_CREATED)
def create_team(
    team_create: TeamCreate,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """
    Create new Team.

    If namespace is provided in the request body, creates the team in that group's namespace.
    User must have Developer+ permission in the group.
    """
    # Use namespace from request body
    group_name = team_create.namespace if team_create.namespace != "default" else None
    return team_kinds_service.create_with_user(
        db=db, obj_in=team_create, user_id=current_user.id, group_name=group_name
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
    force_identity_change: bool = Query(False),
    confirm_name: str | None = Query(None),
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """Update Team information"""
    return team_kinds_service.update_with_user(
        db=db,
        team_id=team_id,
        obj_in=team_update,
        user_id=current_user.id,
        force_identity_change=force_identity_change,
        confirm_name=confirm_name,
    )


@router.delete("/{team_id}")
def delete_team(
    team_id: int,
    force: bool = Query(False, description="Confirm destructive deletion"),
    confirm_name: str | None = Query(None),
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    team_kinds_service.delete_with_user(
        db=db,
        team_id=team_id,
        user_id=current_user.id,
        force=force,
        confirm_name=confirm_name,
    )
    return {"message": "Team deleted successfully"}


@router.get("/{team_id}/copy-preflight")
def get_copy_preflight(
    team_id: int,
    target_namespace: str = Query(..., description="Target namespace to copy into"),
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """
    Return personal skills that would need to be copied when copying this team
    to the given target namespace.

    Returns: { personal_skills: [{id, name, description}] }
    """
    return team_kinds_service.get_copy_preflight(
        db=db,
        team_id=team_id,
        user_id=current_user.id,
        target_namespace=target_namespace,
    )


@router.post(
    "/{team_id}/copy", response_model=TeamInDB, status_code=status.HTTP_201_CREATED
)
def copy_team(
    team_id: int,
    target_namespace: Optional[str] = Query(
        None,
        description="Target namespace to copy into. Defaults to the original team's namespace. Use 'default' for personal space or a group name for group space.",
    ),
    copy_skills: bool = Query(
        False,
        description="If true, target_namespace receives bindings to private Skills referenced by the team's bots.",
    ),
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """
    Copy a team.

    Solo mode: deep copy — clones the leader bot and creates a new team.
    Non-solo mode: shallow copy — creates a new team referencing the same bots.

    New team name: 'Copy of {original_name}'.

    If target_namespace is provided, the copy is placed in that namespace instead of the original.
    User must have Developer+ permission in the target group namespace.
    """
    return team_kinds_service.copy_team(
        db=db,
        team_id=team_id,
        user_id=current_user.id,
        target_namespace=target_namespace,
        copy_skills=copy_skills,
    )


@router.get("/{team_id}/running-tasks")
def check_team_running_tasks(
    team_id: int,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """Check if team has any running tasks"""
    result = team_kinds_service.check_running_tasks(
        db=db, team_id=team_id, user_id=current_user.id
    )
    return result


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
