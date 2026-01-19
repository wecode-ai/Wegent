# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Admin public bot management endpoints."""

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Path, Query, status
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core.security import get_admin_user
from app.models.kind import Kind
from app.models.user import User
from app.schemas.admin import (
    PublicBotCreate,
    PublicBotListResponse,
    PublicBotResponse,
    PublicBotUpdate,
)

router = APIRouter()


def _get_bot_ref_info(
    bot: Kind,
) -> tuple[Optional[str], Optional[str], Optional[str]]:
    """Extract ghost, shell, and model reference names from bot json."""
    ghost_name = None
    shell_name = None
    model_name = None

    if bot.json and isinstance(bot.json, dict):
        spec = bot.json.get("spec", {})
        if isinstance(spec, dict):
            ghost_ref = spec.get("ghostRef", {})
            shell_ref = spec.get("shellRef", {})
            model_ref = spec.get("modelRef", {})

            if isinstance(ghost_ref, dict):
                ghost_name = ghost_ref.get("name")
            if isinstance(shell_ref, dict):
                shell_name = shell_ref.get("name")
            if isinstance(model_ref, dict):
                model_name = model_ref.get("name")

    return (ghost_name, shell_name, model_name)


def _get_bot_display_name(bot: Kind) -> Optional[str]:
    """Extract displayName from bot json metadata."""
    if bot.json and isinstance(bot.json, dict):
        metadata = bot.json.get("metadata", {})
        if isinstance(metadata, dict):
            display_name = metadata.get("displayName")
            if display_name and display_name != bot.name:
                return display_name
    return None


def _validate_bot_resource_references(
    db: Session, bot_json: dict
) -> tuple[bool, Optional[str]]:
    """
    Validate that all resources referenced by the bot (Ghost, Shell, Model) are public.

    Returns:
        (is_valid, error_message)
    """
    # Defensive type checking
    if not isinstance(bot_json, dict):
        return (False, "Invalid bot JSON: must be an object")

    spec = bot_json.get("spec", {})
    if not isinstance(spec, dict):
        return (False, "Invalid bot JSON: 'spec' must be an object")

    # Validate ghostRef
    ghost_ref = spec.get("ghostRef", {})
    if ghost_ref and not isinstance(ghost_ref, dict):
        return (False, "Invalid bot JSON: 'spec.ghostRef' must be an object")
    if isinstance(ghost_ref, dict):
        ghost_name = ghost_ref.get("name")
        ghost_namespace = ghost_ref.get("namespace", "default")
        if ghost_name and isinstance(ghost_name, str):
            ghost = (
                db.query(Kind)
                .filter(
                    Kind.user_id == 0,
                    Kind.kind == "Ghost",
                    Kind.name == ghost_name,
                    Kind.namespace == ghost_namespace,
                    Kind.is_active == True,
                )
                .first()
            )
            if not ghost:
                return (
                    False,
                    f"Ghost '{ghost_namespace}/{ghost_name}' is not a public resource. Please create it as a public ghost first.",
                )

    # Validate shellRef
    shell_ref = spec.get("shellRef", {})
    if shell_ref and not isinstance(shell_ref, dict):
        return (False, "Invalid bot JSON: 'spec.shellRef' must be an object")
    if isinstance(shell_ref, dict):
        shell_name = shell_ref.get("name")
        shell_namespace = shell_ref.get("namespace", "default")
        if shell_name and isinstance(shell_name, str):
            shell = (
                db.query(Kind)
                .filter(
                    Kind.user_id == 0,
                    Kind.kind == "Shell",
                    Kind.name == shell_name,
                    Kind.namespace == shell_namespace,
                    Kind.is_active == True,
                )
                .first()
            )
            if not shell:
                return (
                    False,
                    f"Shell '{shell_namespace}/{shell_name}' is not a public resource. Please create it as a public shell first.",
                )

    # Validate modelRef (optional)
    model_ref = spec.get("modelRef")
    if model_ref:
        if not isinstance(model_ref, dict):
            return (False, "Invalid bot JSON: 'spec.modelRef' must be an object")
        model_name = model_ref.get("name")
        model_namespace = model_ref.get("namespace", "default")
        if model_name and isinstance(model_name, str):
            model = (
                db.query(Kind)
                .filter(
                    Kind.user_id == 0,
                    Kind.kind == "Model",
                    Kind.name == model_name,
                    Kind.namespace == model_namespace,
                    Kind.is_active == True,
                )
                .first()
            )
            if not model:
                return (
                    False,
                    f"Model '{model_namespace}/{model_name}' is not a public resource. Please create it as a public model first.",
                )

    return (True, None)


def _bot_to_response(bot: Kind) -> PublicBotResponse:
    """Convert Kind model to PublicBotResponse."""
    ghost_name, shell_name, model_name = _get_bot_ref_info(bot)
    return PublicBotResponse(
        id=bot.id,
        name=bot.name,
        namespace=bot.namespace,
        display_name=_get_bot_display_name(bot),
        bot_json=bot.json,
        is_active=bot.is_active,
        created_at=bot.created_at,
        updated_at=bot.updated_at,
        ghost_name=ghost_name,
        shell_name=shell_name,
        model_name=model_name,
    )


@router.get("/public-bots", response_model=PublicBotListResponse)
async def list_public_bots(
    page: int = Query(1, ge=1),
    limit: int = Query(20, ge=1, le=100),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin_user),
):
    """
    Get list of all public bots with pagination
    """
    query = db.query(Kind).filter(Kind.user_id == 0, Kind.kind == "Bot")
    total = query.count()

    # Apply SQL-level pagination
    paginated_bots = (
        query.order_by(Kind.updated_at.desc())
        .offset((page - 1) * limit)
        .limit(limit)
        .all()
    )

    return PublicBotListResponse(
        total=total,
        items=[_bot_to_response(bot) for bot in paginated_bots],
    )


@router.post(
    "/public-bots",
    response_model=PublicBotResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_public_bot(
    bot_data: PublicBotCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin_user),
):
    """
    Create a new public bot (admin only).
    All resources referenced by the bot (Ghost, Shell, Model) must be public (user_id=0).
    """
    # Check if bot with same name and namespace already exists
    existing_bot = (
        db.query(Kind)
        .filter(
            Kind.user_id == 0,
            Kind.kind == "Bot",
            Kind.name == bot_data.name,
            Kind.namespace == bot_data.namespace,
        )
        .first()
    )
    if existing_bot:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Public bot '{bot_data.name}' already exists in namespace '{bot_data.namespace}'",
        )

    # Validate resource references
    is_valid, error_message = _validate_bot_resource_references(db, bot_data.bot_json)
    if not is_valid:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=error_message,
        )

    new_bot = Kind(
        user_id=0,
        kind="Bot",
        name=bot_data.name,
        namespace=bot_data.namespace,
        json=bot_data.bot_json,
        is_active=True,
    )
    db.add(new_bot)
    db.commit()
    db.refresh(new_bot)

    return _bot_to_response(new_bot)


@router.put("/public-bots/{bot_id}", response_model=PublicBotResponse)
async def update_public_bot(
    bot_data: PublicBotUpdate,
    bot_id: int = Path(..., description="Bot ID"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin_user),
):
    """
    Update a public bot (admin only).
    All resources referenced by the bot (Ghost, Shell, Model) must be public (user_id=0).
    """
    bot = (
        db.query(Kind)
        .filter(Kind.id == bot_id, Kind.user_id == 0, Kind.kind == "Bot")
        .first()
    )
    if not bot:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Public bot with id {bot_id} not found",
        )

    # Check name uniqueness if being changed
    if bot_data.name and bot_data.name != bot.name:
        namespace = bot_data.namespace or bot.namespace
        existing_bot = (
            db.query(Kind)
            .filter(
                Kind.user_id == 0,
                Kind.kind == "Bot",
                Kind.name == bot_data.name,
                Kind.namespace == namespace,
            )
            .first()
        )
        if existing_bot:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Public bot '{bot_data.name}' already exists in namespace '{namespace}'",
            )

    # Validate resource references if json is being updated
    if bot_data.bot_json:
        is_valid, error_message = _validate_bot_resource_references(
            db, bot_data.bot_json
        )
        if not is_valid:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=error_message,
            )

    # Update fields
    if bot_data.name is not None:
        bot.name = bot_data.name
    if bot_data.namespace is not None:
        bot.namespace = bot_data.namespace
    if bot_data.bot_json is not None:
        bot.json = bot_data.bot_json
    if bot_data.is_active is not None:
        bot.is_active = bot_data.is_active

    db.commit()
    db.refresh(bot)

    return _bot_to_response(bot)


@router.delete("/public-bots/{bot_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_public_bot(
    bot_id: int = Path(..., description="Bot ID"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin_user),
):
    """
    Delete a public bot (admin only).
    Deletion is blocked if any public teams (active or inactive) reference this bot.
    """
    bot = (
        db.query(Kind)
        .filter(Kind.id == bot_id, Kind.user_id == 0, Kind.kind == "Bot")
        .first()
    )
    if not bot:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Public bot with id {bot_id} not found",
        )

    # Check if any public teams (active or inactive) reference this bot
    teams_using_bot = (
        db.query(Kind)
        .filter(
            Kind.user_id == 0,
            Kind.kind == "Team",
        )
        .all()
    )

    referencing_teams = []
    for team in teams_using_bot:
        # Defensive validation: ensure team.json is a dict
        if not isinstance(team.json, dict):
            continue
        spec = team.json.get("spec", {})
        # Defensive validation: ensure spec is a dict
        if not isinstance(spec, dict):
            continue
        members = spec.get("members", [])
        # Defensive validation: ensure members is a list
        if not isinstance(members, list):
            continue
        for member in members:
            # Defensive validation: ensure member is a dict
            if not isinstance(member, dict):
                continue
            bot_ref = member.get("botRef")
            # Defensive validation: ensure botRef is a dict
            if not isinstance(bot_ref, dict):
                continue
            if (
                bot_ref.get("name") == bot.name
                and bot_ref.get("namespace", "default") == bot.namespace
            ):
                referencing_teams.append(team.name)
                break

    if referencing_teams:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Cannot delete bot '{bot.name}' because it is referenced by public teams: {', '.join(referencing_teams)}",
        )

    db.delete(bot)
    db.commit()

    return None
