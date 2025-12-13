# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import logging
import time
from typing import Optional

from fastapi import APIRouter, Depends, Query, status
from sqlalchemy.orm import Session

logger = logging.getLogger(__name__)

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

router = APIRouter()


@router.get("", response_model=TeamListResponse)
def list_teams(
    page: int = Query(1, ge=1, description="Page number"),
    limit: int = Query(10, ge=1, le=100, description="Items per page"),
    scope: str = Query(
        "personal",
        description="Query scope: 'personal' (default), 'group', or 'all'",
    ),
    group_name: Optional[str] = Query(
        None, description="Group name (required when scope='group')"
    ),
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Get current user's Team list (paginated) with scope support.

    Scope behavior:
    - scope='personal' (default): personal teams + shared teams
    - scope='group': group teams (requires group_name)
    - scope='all': personal + shared + all user's groups
    """
    api_start = time.time()
    logger.info(
        f"[list_teams] START user_id={current_user.id}, page={page}, limit={limit}, scope={scope}, group_name={group_name}"
    )

    skip = (page - 1) * limit

    t1 = time.time()
    items = team_kinds_service.get_user_teams(
        db=db,
        user_id=current_user.id,
        skip=skip,
        limit=limit,
        scope=scope,
        group_name=group_name,
    )
    logger.info(
        f"[list_teams] get_user_teams took {time.time() - t1:.3f}s, returned {len(items)} items"
    )

    t2 = time.time()
    if page == 1 and len(items) < limit:
        total = len(items)
    else:
        total = team_kinds_service.count_user_teams(
            db=db, user_id=current_user.id, scope=scope, group_name=group_name
        )
    logger.info(
        f"[list_teams] count_user_teams took {time.time() - t2:.3f}s, total={total}"
    )

    logger.info(f"[list_teams] TOTAL API took {time.time() - api_start:.3f}s")
    return {"total": total, "items": items}


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
    force: bool = Query(
        False, description="Force delete even if team has running tasks"
    ),
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    team_kinds_service.delete_with_user(
        db=db, team_id=team_id, user_id=current_user.id, force=force
    )
    return {"message": "Team deactivated successfully"}


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
