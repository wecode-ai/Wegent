# SPDX-FileCopyrightText: 2025 WeCode, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Quick teams API endpoints for public access
"""
from typing import List, Optional

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core.security import get_current_user
from app.models.kind import Kind
from app.models.system_config import SystemConfig
from app.models.user import User
from app.schemas.quick_teams import QuickTeamResponse, QuickTeamsListResponse

router = APIRouter()

QUICK_TEAMS_CONFIG_KEY = "quick_teams"


def get_quick_teams_config(db: Session) -> dict:
    """Get quick teams configuration from system config"""
    config = (
        db.query(SystemConfig)
        .filter(SystemConfig.config_key == QUICK_TEAMS_CONFIG_KEY)
        .first()
    )
    if config and config.config_value:
        return config.config_value
    return {"chat": [], "code": []}


@router.get("/quick-teams", response_model=QuickTeamsListResponse)
async def get_quick_teams(
    scene: str = Query(..., description="Scene type: chat or code"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Get quick teams list for specified scene (public endpoint)

    Returns teams with their full information for display
    """
    config = get_quick_teams_config(db)
    scene_config = config.get(scene, [])

    # Build team_id to config mapping
    team_configs = {item["team_id"]: item for item in scene_config}
    team_ids = list(team_configs.keys())

    if not team_ids:
        return QuickTeamsListResponse(items=[])

    # Query teams from Kind table
    teams = (
        db.query(Kind)
        .filter(Kind.kind == "Team", Kind.id.in_(team_ids))
        .all()
    )

    # Build response with team info
    items: List[QuickTeamResponse] = []
    for team in teams:
        team_config = team_configs.get(team.id, {})
        spec = team.spec or {}
        metadata = team.metadata_ or {}

        items.append(
            QuickTeamResponse(
                team_id=team.id,
                team_name=metadata.get("name", ""),
                team_namespace=metadata.get("namespace", "default"),
                description=spec.get("description"),
                icon=team_config.get("icon", "Users"),
                sort_order=team_config.get("sort_order", 0),
            )
        )

    # Sort by sort_order
    items.sort(key=lambda x: x.sort_order)

    return QuickTeamsListResponse(items=items)
