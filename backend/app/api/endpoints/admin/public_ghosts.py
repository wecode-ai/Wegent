# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Admin public ghost management endpoints."""

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Path, Query, status
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core.security import get_admin_user
from app.models.kind import Kind
from app.models.user import User
from app.schemas.admin import (
    PublicGhostCreate,
    PublicGhostListResponse,
    PublicGhostResponse,
    PublicGhostUpdate,
)

router = APIRouter()


def _get_ghost_display_name(ghost: Kind) -> Optional[str]:
    """Extract displayName from ghost json metadata."""
    if ghost.json and isinstance(ghost.json, dict):
        metadata = ghost.json.get("metadata", {})
        if isinstance(metadata, dict):
            display_name = metadata.get("displayName")
            if display_name and display_name != ghost.name:
                return display_name
    return None


def _get_ghost_description(ghost: Kind) -> Optional[str]:
    """Extract description from ghost json spec."""
    if ghost.json and isinstance(ghost.json, dict):
        spec = ghost.json.get("spec", {})
        if isinstance(spec, dict):
            return spec.get("description")
    return None


def _ghost_to_response(ghost: Kind) -> PublicGhostResponse:
    """Convert Kind model to PublicGhostResponse."""
    return PublicGhostResponse(
        id=ghost.id,
        name=ghost.name,
        namespace=ghost.namespace,
        display_name=_get_ghost_display_name(ghost),
        description=_get_ghost_description(ghost),
        ghost_json=ghost.json,
        is_active=ghost.is_active,
        created_at=ghost.created_at,
        updated_at=ghost.updated_at,
    )


@router.get("/public-ghosts", response_model=PublicGhostListResponse)
async def list_public_ghosts(
    page: int = Query(1, ge=1),
    limit: int = Query(20, ge=1, le=100),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin_user),
):
    """
    Get list of all public ghosts with pagination
    """
    query = db.query(Kind).filter(Kind.user_id == 0, Kind.kind == "Ghost")
    total = query.count()

    # Apply SQL-level pagination
    paginated_ghosts = (
        query.order_by(Kind.updated_at.desc())
        .offset((page - 1) * limit)
        .limit(limit)
        .all()
    )

    return PublicGhostListResponse(
        total=total,
        items=[_ghost_to_response(ghost) for ghost in paginated_ghosts],
    )


@router.post(
    "/public-ghosts",
    response_model=PublicGhostResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_public_ghost(
    ghost_data: PublicGhostCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin_user),
):
    """
    Create a new public ghost (admin only).
    """
    # Check if ghost with same name and namespace already exists
    existing_ghost = (
        db.query(Kind)
        .filter(
            Kind.user_id == 0,
            Kind.kind == "Ghost",
            Kind.name == ghost_data.name,
            Kind.namespace == ghost_data.namespace,
        )
        .first()
    )
    if existing_ghost:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Public ghost '{ghost_data.name}' already exists in namespace '{ghost_data.namespace}'",
        )

    new_ghost = Kind(
        user_id=0,
        kind="Ghost",
        name=ghost_data.name,
        namespace=ghost_data.namespace,
        json=ghost_data.ghost_json,
        is_active=True,
    )
    db.add(new_ghost)
    db.commit()
    db.refresh(new_ghost)

    return _ghost_to_response(new_ghost)


@router.put("/public-ghosts/{ghost_id}", response_model=PublicGhostResponse)
async def update_public_ghost(
    ghost_data: PublicGhostUpdate,
    ghost_id: int = Path(..., description="Ghost ID"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin_user),
):
    """
    Update a public ghost (admin only).
    """
    ghost = (
        db.query(Kind)
        .filter(Kind.id == ghost_id, Kind.user_id == 0, Kind.kind == "Ghost")
        .first()
    )
    if not ghost:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Public ghost with id {ghost_id} not found",
        )

    # Check name uniqueness if being changed
    if ghost_data.name and ghost_data.name != ghost.name:
        namespace = ghost_data.namespace or ghost.namespace
        existing_ghost = (
            db.query(Kind)
            .filter(
                Kind.user_id == 0,
                Kind.kind == "Ghost",
                Kind.name == ghost_data.name,
                Kind.namespace == namespace,
            )
            .first()
        )
        if existing_ghost:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Public ghost '{ghost_data.name}' already exists in namespace '{namespace}'",
            )

    # Update fields
    if ghost_data.name is not None:
        ghost.name = ghost_data.name
    if ghost_data.namespace is not None:
        ghost.namespace = ghost_data.namespace
    if ghost_data.ghost_json is not None:
        ghost.json = ghost_data.ghost_json
    if ghost_data.is_active is not None:
        ghost.is_active = ghost_data.is_active

    db.commit()
    db.refresh(ghost)

    return _ghost_to_response(ghost)


@router.delete("/public-ghosts/{ghost_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_public_ghost(
    ghost_id: int = Path(..., description="Ghost ID"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin_user),
):
    """
    Delete a public ghost (admin only).
    Deletion is blocked if any public bots (active or inactive) reference this ghost.
    """
    ghost = (
        db.query(Kind)
        .filter(Kind.id == ghost_id, Kind.user_id == 0, Kind.kind == "Ghost")
        .first()
    )
    if not ghost:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Public ghost with id {ghost_id} not found",
        )

    # Check if any public bots (active or inactive) reference this ghost
    bots_using_ghost = (
        db.query(Kind)
        .filter(
            Kind.user_id == 0,
            Kind.kind == "Bot",
        )
        .all()
    )

    referencing_bots = []
    for bot in bots_using_ghost:
        # Defensive validation: ensure bot.json is a dict
        if not isinstance(bot.json, dict):
            continue
        spec = bot.json.get("spec", {})
        # Defensive validation: ensure spec is a dict
        if not isinstance(spec, dict):
            continue
        ghost_ref = spec.get("ghostRef")
        # Defensive validation: ensure ghostRef is a dict
        if not isinstance(ghost_ref, dict):
            continue
        if (
            ghost_ref.get("name") == ghost.name
            and ghost_ref.get("namespace", "default") == ghost.namespace
        ):
            referencing_bots.append(bot.name)

    if referencing_bots:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Cannot delete ghost '{ghost.name}' because it is referenced by public bots: {', '.join(referencing_bots)}",
        )

    db.delete(ghost)
    db.commit()

    return None
