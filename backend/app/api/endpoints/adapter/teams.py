# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import logging
import time
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, Query, status
from sqlalchemy.orm import Session

logger = logging.getLogger(__name__)

from app.api.dependencies import get_db
from app.core import security
from app.core.config import settings
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
    TeamSkillsResponse,
    TeamUpdate,
)
from app.services.adapters.team_kinds import team_kinds_service
from app.services.shared_team import shared_team_service

router = APIRouter()


def _get_default_teams_config() -> Dict[str, Dict[str, str]]:
    """
    Parse default teams configuration from environment variables.
    Returns a dict mapping mode -> {name, namespace}.
    """
    config = {}
    mode_settings = {
        "chat": settings.DEFAULT_TEAM_CHAT,
        "code": settings.DEFAULT_TEAM_CODE,
        "knowledge": settings.DEFAULT_TEAM_KNOWLEDGE,
        "task": settings.DEFAULT_TEAM_TASK,
    }

    for mode, value in mode_settings.items():
        if value and value.strip():
            parts = value.strip().split("#", 1)
            name = parts[0].strip()
            namespace = parts[1].strip() if len(parts) > 1 else "default"
            if name:
                config[mode] = {"name": name, "namespace": namespace}

    return config


def _add_default_for_modes(
    items: List[Dict[str, Any]], default_config: Dict[str, Dict[str, str]]
) -> List[Dict[str, Any]]:
    """
    Add default_for_modes field to each team item based on default teams config.
    """
    for item in items:
        default_modes = []
        team_name = item.get("name")
        team_namespace = item.get("namespace") or "default"

        for mode, config in default_config.items():
            if config["name"] == team_name and config["namespace"] == team_namespace:
                default_modes.append(mode)

        item["default_for_modes"] = default_modes

    return items


@router.get("")
def list_teams(
    page: int = Query(1, ge=1, description="Page number"),
    limit: int = Query(10, ge=1, le=100, description="Items per page"),
    scope: str = Query(
        "all",
        description="Query scope: 'personal', 'group', or 'all' (default)",
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
    - scope='personal': personal teams + shared teams
    - scope='group': group teams (requires group_name)
    - scope='all' (default): personal + shared + all user's groups

    Each team item includes a `default_for_modes` field (list of mode names)
    indicating which modes this team is the default for (based on env config).
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

    # Add default_for_modes field to each team based on env config
    default_config = _get_default_teams_config()
    items = _add_default_for_modes(items, default_config)

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


@router.post(
    "/{team_id}/copy", response_model=TeamInDB, status_code=status.HTTP_201_CREATED
)
def copy_team(
    team_id: int,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """
    Copy a team.

    Solo mode: deep copy — clones the leader bot and creates a new team.
    Non-solo mode: shallow copy — creates a new team referencing the same bots.

    New team name: 'Copy of {original_name}'.
    """
    return team_kinds_service.copy_team(db=db, team_id=team_id, user_id=current_user.id)


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


@router.get("/{team_id}/skills", response_model=TeamSkillsResponse)
def get_team_skills(
    team_id: int,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """Get all skills associated with a team.

    Follows the chain: team → bots → ghosts → skills

    Returns:
        TeamSkillsResponse with team_id, team_namespace,
        skills list (deduplicated), and preload_skills list.
    """
    return team_kinds_service.get_team_skills(
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
