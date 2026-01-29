# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Admin public shell management endpoints."""

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Path, Query, status
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core.security import get_admin_user
from app.models.kind import Kind
from app.models.user import User
from app.schemas.admin import (
    PublicShellCreate,
    PublicShellListResponse,
    PublicShellResponse,
    PublicShellUpdate,
)

router = APIRouter()


def _get_shell_display_name(shell: Kind) -> Optional[str]:
    """Extract displayName from shell json metadata."""
    if shell.json and isinstance(shell.json, dict):
        metadata = shell.json.get("metadata", {})
        if isinstance(metadata, dict):
            display_name = metadata.get("displayName")
            if display_name and display_name != shell.name:
                return display_name
    return None


def _get_shell_type(shell: Kind) -> Optional[str]:
    """Extract shellType from shell json spec."""
    if shell.json and isinstance(shell.json, dict):
        spec = shell.json.get("spec", {})
        if isinstance(spec, dict):
            return spec.get("shellType")
    return None


def _shell_to_response(shell: Kind) -> PublicShellResponse:
    """Convert Kind model to PublicShellResponse."""
    return PublicShellResponse(
        id=shell.id,
        name=shell.name,
        namespace=shell.namespace,
        display_name=_get_shell_display_name(shell),
        shell_type=_get_shell_type(shell),
        shell_json=shell.json,
        is_active=shell.is_active,
        created_at=shell.created_at,
        updated_at=shell.updated_at,
    )


@router.get("/public-shells", response_model=PublicShellListResponse)
async def list_public_shells(
    page: int = Query(1, ge=1),
    limit: int = Query(20, ge=1, le=1000),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin_user),
):
    """
    Get list of all public shells with pagination
    """
    query = db.query(Kind).filter(Kind.user_id == 0, Kind.kind == "Shell")
    total = query.count()

    # Apply SQL-level pagination
    paginated_shells = (
        query.order_by(Kind.updated_at.desc())
        .offset((page - 1) * limit)
        .limit(limit)
        .all()
    )

    return PublicShellListResponse(
        total=total,
        items=[_shell_to_response(shell) for shell in paginated_shells],
    )


@router.post(
    "/public-shells",
    response_model=PublicShellResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_public_shell(
    shell_data: PublicShellCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin_user),
):
    """
    Create a new public shell (admin only).
    """
    # Check if shell with same name and namespace already exists
    existing_shell = (
        db.query(Kind)
        .filter(
            Kind.user_id == 0,
            Kind.kind == "Shell",
            Kind.name == shell_data.name,
            Kind.namespace == shell_data.namespace,
        )
        .first()
    )
    if existing_shell:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Public shell '{shell_data.name}' already exists in namespace '{shell_data.namespace}'",
        )

    new_shell = Kind(
        user_id=0,
        kind="Shell",
        name=shell_data.name,
        namespace=shell_data.namespace,
        json=shell_data.shell_json,
        is_active=True,
    )
    db.add(new_shell)
    db.commit()
    db.refresh(new_shell)

    return _shell_to_response(new_shell)


@router.put("/public-shells/{shell_id}", response_model=PublicShellResponse)
async def update_public_shell(
    shell_data: PublicShellUpdate,
    shell_id: int = Path(..., description="Shell ID"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin_user),
):
    """
    Update a public shell (admin only).
    """
    shell = (
        db.query(Kind)
        .filter(Kind.id == shell_id, Kind.user_id == 0, Kind.kind == "Shell")
        .first()
    )
    if not shell:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Public shell with id {shell_id} not found",
        )

    # Check name uniqueness if being changed
    if shell_data.name and shell_data.name != shell.name:
        namespace = shell_data.namespace or shell.namespace
        existing_shell = (
            db.query(Kind)
            .filter(
                Kind.user_id == 0,
                Kind.kind == "Shell",
                Kind.name == shell_data.name,
                Kind.namespace == namespace,
            )
            .first()
        )
        if existing_shell:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Public shell '{shell_data.name}' already exists in namespace '{namespace}'",
            )

    # Update fields
    if shell_data.name is not None:
        shell.name = shell_data.name
    if shell_data.namespace is not None:
        shell.namespace = shell_data.namespace
    if shell_data.shell_json is not None:
        shell.json = shell_data.shell_json
    if shell_data.is_active is not None:
        shell.is_active = shell_data.is_active

    db.commit()
    db.refresh(shell)

    return _shell_to_response(shell)


@router.delete("/public-shells/{shell_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_public_shell(
    shell_id: int = Path(..., description="Shell ID"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin_user),
):
    """
    Delete a public shell (admin only).
    Deletion is blocked if any public bots (active or inactive) reference this shell.
    """
    shell = (
        db.query(Kind)
        .filter(Kind.id == shell_id, Kind.user_id == 0, Kind.kind == "Shell")
        .first()
    )
    if not shell:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Public shell with id {shell_id} not found",
        )

    # Check if any public bots (active or inactive) reference this shell
    bots_using_shell = (
        db.query(Kind)
        .filter(
            Kind.user_id == 0,
            Kind.kind == "Bot",
        )
        .all()
    )

    referencing_bots = []
    for bot in bots_using_shell:
        # Defensive validation: ensure bot.json is a dict
        if not isinstance(bot.json, dict):
            continue
        spec = bot.json.get("spec", {})
        # Defensive validation: ensure spec is a dict
        if not isinstance(spec, dict):
            continue
        shell_ref = spec.get("shellRef")
        # Defensive validation: ensure shellRef is a dict
        if not isinstance(shell_ref, dict):
            continue
        if (
            shell_ref.get("name") == shell.name
            and shell_ref.get("namespace", "default") == shell.namespace
        ):
            referencing_bots.append(bot.name)

    if referencing_bots:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Cannot delete shell '{shell.name}' because it is referenced by public bots: {', '.join(referencing_bots)}",
        )

    db.delete(shell)
    db.commit()

    return None
