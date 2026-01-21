# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Admin public team management endpoints."""

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Path, Query, status
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core.security import get_admin_user
from app.models.kind import Kind
from app.models.user import User
from app.schemas.admin import (
    PublicTeamCreate,
    PublicTeamListResponse,
    PublicTeamResponse,
    PublicTeamUpdate,
)
from shared.telemetry.decorators import trace_async

router = APIRouter()


def _get_team_description(team: Kind) -> Optional[str]:
    """Extract description from team json."""
    if team.json and isinstance(team.json, dict):
        spec = team.json.get("spec", {})
        if isinstance(spec, dict):
            return spec.get("description")
    return None


def _get_team_display_name(team: Kind) -> Optional[str]:
    """Extract displayName from team json metadata."""
    if team.json and isinstance(team.json, dict):
        metadata = team.json.get("metadata", {})
        if isinstance(metadata, dict):
            display_name = metadata.get("displayName")
            if display_name and display_name != team.name:
                return display_name
    return None


def _validate_team_bot_references(
    db: Session, team_json: dict
) -> tuple[bool, Optional[str]]:
    """
    Validate that all bots referenced by the team are public bots.

    Returns:
        (is_valid, error_message)
    """
    # Defensive type checking
    if not isinstance(team_json, dict):
        return (False, "Invalid team JSON: must be an object")

    spec = team_json.get("spec", {})
    if not isinstance(spec, dict):
        return (False, "Invalid team JSON: 'spec' must be an object")

    members = spec.get("members", [])
    if not isinstance(members, list):
        return (False, "Invalid team JSON: 'spec.members' must be an array")

    for member in members:
        if not isinstance(member, dict):
            continue
        bot_ref = member.get("botRef", {})
        if not isinstance(bot_ref, dict):
            continue
        bot_name = bot_ref.get("name")
        if not isinstance(bot_name, str) or not bot_name:
            continue
        bot_namespace = bot_ref.get("namespace", "default")

        # Check if bot exists as a public resource (user_id=0)
        bot = (
            db.query(Kind)
            .filter(
                Kind.user_id == 0,
                Kind.kind == "Bot",
                Kind.name == bot_name,
                Kind.namespace == bot_namespace,
                Kind.is_active == True,
            )
            .first()
        )

        if not bot:
            return (
                False,
                f"Bot '{bot_namespace}/{bot_name}' is not a public resource. Please create it as a public bot first.",
            )

    return (True, None)


def _team_to_response(team: Kind) -> PublicTeamResponse:
    """Convert Kind model to PublicTeamResponse."""
    return PublicTeamResponse(
        id=team.id,
        name=team.name,
        namespace=team.namespace,
        display_name=_get_team_display_name(team),
        description=_get_team_description(team),
        team_json=team.json,
        is_active=team.is_active,
        created_at=team.created_at,
        updated_at=team.updated_at,
    )


@router.get("/public-teams", response_model=PublicTeamListResponse)
@trace_async()
async def list_public_teams(
    page: int = Query(1, ge=1),
    limit: int = Query(20, ge=1, le=100),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin_user),
):
    """
    Get list of all public teams with pagination
    """
    query = db.query(Kind).filter(Kind.user_id == 0, Kind.kind == "Team")
    total = query.count()

    # Apply SQL-level pagination
    paginated_teams = (
        query.order_by(Kind.updated_at.desc())
        .offset((page - 1) * limit)
        .limit(limit)
        .all()
    )

    return PublicTeamListResponse(
        total=total,
        items=[_team_to_response(team) for team in paginated_teams],
    )


@router.post(
    "/public-teams",
    response_model=PublicTeamResponse,
    status_code=status.HTTP_201_CREATED,
)
@trace_async()
async def create_public_team(
    team_data: PublicTeamCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin_user),
):
    """
    Create a new public team (admin only).
    All bots referenced by the team must be public bots (user_id=0).
    """
    # Check if team with same name and namespace already exists
    existing_team = (
        db.query(Kind)
        .filter(
            Kind.user_id == 0,
            Kind.kind == "Team",
            Kind.name == team_data.name,
            Kind.namespace == team_data.namespace,
        )
        .first()
    )
    if existing_team:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Public team '{team_data.name}' already exists in namespace '{team_data.namespace}'",
        )

    # Validate bot references
    is_valid, error_message = _validate_team_bot_references(db, team_data.team_json)
    if not is_valid:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=error_message,
        )

    new_team = Kind(
        user_id=0,
        kind="Team",
        name=team_data.name,
        namespace=team_data.namespace,
        json=team_data.team_json,
        is_active=True,
    )
    db.add(new_team)
    db.commit()
    db.refresh(new_team)

    return _team_to_response(new_team)


@router.put("/public-teams/{team_id}", response_model=PublicTeamResponse)
@trace_async()
async def update_public_team(
    team_data: PublicTeamUpdate,
    team_id: int = Path(..., description="Team ID"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin_user),
):
    """
    Update a public team (admin only).
    All bots referenced by the team must be public bots (user_id=0).
    """
    team = (
        db.query(Kind)
        .filter(Kind.id == team_id, Kind.user_id == 0, Kind.kind == "Team")
        .first()
    )
    if not team:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Public team with id {team_id} not found",
        )

    # Check name uniqueness if being changed
    if team_data.name and team_data.name != team.name:
        namespace = team_data.namespace or team.namespace
        existing_team = (
            db.query(Kind)
            .filter(
                Kind.user_id == 0,
                Kind.kind == "Team",
                Kind.name == team_data.name,
                Kind.namespace == namespace,
            )
            .first()
        )
        if existing_team:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Public team '{team_data.name}' already exists in namespace '{namespace}'",
            )

    # Validate bot references if json is being updated
    if team_data.team_json:
        is_valid, error_message = _validate_team_bot_references(db, team_data.team_json)
        if not is_valid:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=error_message,
            )

    # Update fields
    if team_data.name is not None:
        team.name = team_data.name
    if team_data.namespace is not None:
        team.namespace = team_data.namespace
    if team_data.team_json is not None:
        team.json = team_data.team_json
    if team_data.is_active is not None:
        team.is_active = team_data.is_active

    db.commit()
    db.refresh(team)

    return _team_to_response(team)


@router.delete("/public-teams/{team_id}", status_code=status.HTTP_204_NO_CONTENT)
@trace_async()
async def delete_public_team(
    team_id: int = Path(..., description="Team ID"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin_user),
):
    """
    Delete a public team (admin only)
    """
    team = (
        db.query(Kind)
        .filter(Kind.id == team_id, Kind.user_id == 0, Kind.kind == "Team")
        .first()
    )
    if not team:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Public team with id {team_id} not found",
        )

    db.delete(team)
    db.commit()

    return None
