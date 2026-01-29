# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Admin public bot management endpoints."""

import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Path, Query, status
from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified

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
from app.schemas.kind import Ghost, Model
from app.services.adapters.shell_utils import get_shell_info_by_name

logger = logging.getLogger(__name__)

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


def _bot_to_response(bot: Kind, db: Session) -> PublicBotResponse:
    """Convert Kind model to PublicBotResponse with expanded Ghost and Model info."""
    ghost_name, shell_name, model_name = _get_bot_ref_info(bot)

    # Initialize expanded fields
    system_prompt = None
    mcp_servers = None
    skills = None
    agent_config = None

    # Get Ghost info if available
    if ghost_name:
        ghost_namespace = "default"
        if bot.json and isinstance(bot.json, dict):
            spec = bot.json.get("spec", {})
            if isinstance(spec, dict):
                ghost_ref = spec.get("ghostRef", {})
                if isinstance(ghost_ref, dict):
                    ghost_namespace = ghost_ref.get("namespace", "default")

        ghost = (
            db.query(Kind)
            .filter(
                Kind.user_id == 0,
                Kind.kind == "Ghost",
                Kind.name == ghost_name,
                Kind.namespace == ghost_namespace,
            )
            .first()
        )
        if ghost and ghost.json and isinstance(ghost.json, dict):
            ghost_spec = ghost.json.get("spec", {})
            if isinstance(ghost_spec, dict):
                system_prompt = ghost_spec.get("systemPrompt", "")
                mcp_servers = ghost_spec.get("mcpServers", {})
                skills = ghost_spec.get("skills", [])

    # Get Model info if available
    if model_name:
        model_namespace = "default"
        if bot.json and isinstance(bot.json, dict):
            spec = bot.json.get("spec", {})
            if isinstance(spec, dict):
                model_ref = spec.get("modelRef", {})
                if isinstance(model_ref, dict):
                    model_namespace = model_ref.get("namespace", "default")

        model = (
            db.query(Kind)
            .filter(
                Kind.user_id == 0,
                Kind.kind == "Model",
                Kind.name == model_name,
                Kind.namespace == model_namespace,
            )
            .first()
        )
        if model and model.json and isinstance(model.json, dict):
            model_spec = model.json.get("spec", {})
            if isinstance(model_spec, dict):
                # Check if it's a custom config or predefined model
                is_custom = model_spec.get("isCustomConfig", False)
                if is_custom:
                    # Custom model - return modelConfig with protocol
                    model_config = model_spec.get("modelConfig", {})
                    protocol = model_spec.get("protocol")
                    if protocol:
                        agent_config = {**model_config, "protocol": protocol}
                    else:
                        agent_config = model_config
                else:
                    # Predefined model - return bind_model reference
                    metadata = model.json.get("metadata", {})
                    agent_config = {
                        "bind_model": model.name,
                        "bind_model_namespace": model.namespace,
                    }

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
        system_prompt=system_prompt,
        mcp_servers=mcp_servers,
        skills=skills,
        agent_config=agent_config,
    )


@router.get("/public-bots", response_model=PublicBotListResponse)
async def list_public_bots(
    page: int = Query(1, ge=1),
    limit: int = Query(20, ge=1, le=1000),
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
        items=[_bot_to_response(bot, db) for bot in paginated_bots],
    )


def _is_predefined_model(agent_config: dict) -> bool:
    """
    Check if agent_config is a predefined model reference.
    A predefined model config has bind_model and optionally bind_model_type/bind_model_namespace.
    """
    if not agent_config:
        return False
    keys = set(agent_config.keys())
    allowed_keys = {"bind_model", "bind_model_type", "bind_model_namespace"}
    return "bind_model" in keys and keys.issubset(allowed_keys)


def _create_public_ghost(
    db: Session,
    bot_name: str,
    namespace: str,
    system_prompt: str,
    mcp_servers: dict,
    skills: list,
) -> Kind:
    """Create a public Ghost for the bot."""
    ghost_name = f"{bot_name}-ghost"

    # Check if ghost already exists
    existing_ghost = (
        db.query(Kind)
        .filter(
            Kind.user_id == 0,
            Kind.kind == "Ghost",
            Kind.name == ghost_name,
            Kind.namespace == namespace,
        )
        .first()
    )
    if existing_ghost:
        # Update existing ghost
        ghost_crd = Ghost.model_validate(existing_ghost.json)
        ghost_crd.spec.systemPrompt = system_prompt or ""
        ghost_crd.spec.mcpServers = mcp_servers or {}
        ghost_crd.spec.skills = skills or []
        existing_ghost.json = ghost_crd.model_dump()
        flag_modified(existing_ghost, "json")
        return existing_ghost

    # Create new ghost
    ghost_spec = {
        "systemPrompt": system_prompt or "",
        "mcpServers": mcp_servers or {},
    }
    if skills:
        ghost_spec["skills"] = skills

    ghost_json = {
        "kind": "Ghost",
        "spec": ghost_spec,
        "status": {"state": "Available"},
        "metadata": {"name": ghost_name, "namespace": namespace},
        "apiVersion": "agent.wecode.io/v1",
    }

    ghost = Kind(
        user_id=0,
        kind="Ghost",
        name=ghost_name,
        namespace=namespace,
        json=ghost_json,
        is_active=True,
    )
    db.add(ghost)
    return ghost


def _create_public_model(
    db: Session, bot_name: str, namespace: str, agent_config: dict
) -> Optional[Kind]:
    """Create a public Model for the bot if agent_config is custom (not predefined)."""
    if not agent_config or _is_predefined_model(agent_config):
        return None

    model_name = f"{bot_name}-model"

    # Extract protocol from agent_config
    protocol = agent_config.get("protocol")
    model_config = {k: v for k, v in agent_config.items() if k != "protocol"}

    # Check if model already exists
    existing_model = (
        db.query(Kind)
        .filter(
            Kind.user_id == 0,
            Kind.kind == "Model",
            Kind.name == model_name,
            Kind.namespace == namespace,
        )
        .first()
    )
    if existing_model:
        # Update existing model
        model_crd = Model.model_validate(existing_model.json)
        model_crd.spec.modelConfig = model_config
        model_crd.spec.isCustomConfig = True
        model_crd.spec.protocol = protocol
        existing_model.json = model_crd.model_dump()
        flag_modified(existing_model, "json")
        return existing_model

    # Create new model
    model_json = {
        "kind": "Model",
        "spec": {
            "modelConfig": model_config,
            "isCustomConfig": True,
            "protocol": protocol,
        },
        "status": {"state": "Available"},
        "metadata": {"name": model_name, "namespace": namespace},
        "apiVersion": "agent.wecode.io/v1",
    }

    model = Kind(
        user_id=0,
        kind="Model",
        name=model_name,
        namespace=namespace,
        json=model_json,
        is_active=True,
    )
    db.add(model)
    return model


def _build_bot_json_from_form_data(
    bot_name: str,
    namespace: str,
    shell_name: str,
    shell_namespace: str,
    ghost_name: str,
    model_ref_name: Optional[str],
    model_ref_namespace: str,
) -> dict:
    """Build Bot CRD JSON from form data."""
    bot_spec = {
        "ghostRef": {"name": ghost_name, "namespace": namespace},
        "shellRef": {"name": shell_name, "namespace": shell_namespace},
    }

    if model_ref_name:
        bot_spec["modelRef"] = {
            "name": model_ref_name,
            "namespace": model_ref_namespace,
        }

    return {
        "kind": "Bot",
        "spec": bot_spec,
        "status": {"state": "Available"},
        "metadata": {"name": bot_name, "namespace": namespace},
        "apiVersion": "agent.wecode.io/v1",
    }


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

    Supports two modes:
    1. Raw JSON mode: Provide bot_json directly. All referenced resources must be public.
    2. Form data mode: Provide shell_name, system_prompt, mcp_servers, skills, agent_config.
       Ghost and Model will be auto-created as public resources.
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

    # Determine which mode to use
    if bot_data.bot_json:
        # Raw JSON mode - validate resource references
        is_valid, error_message = _validate_bot_resource_references(
            db, bot_data.bot_json
        )
        if not is_valid:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=error_message,
            )
        bot_json = bot_data.bot_json
    elif bot_data.shell_name:
        # Form data mode - auto-create Ghost and optionally Model
        logger.info(f"Creating public bot '{bot_data.name}' in form data mode")

        # Validate shell exists as public resource
        shell = (
            db.query(Kind)
            .filter(
                Kind.user_id == 0,
                Kind.kind == "Shell",
                Kind.name == bot_data.shell_name,
                Kind.is_active == True,
            )
            .first()
        )
        if not shell:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Shell '{bot_data.shell_name}' is not a public resource. Please create it as a public shell first.",
            )
        shell_namespace = shell.namespace

        # Create Ghost
        ghost = _create_public_ghost(
            db,
            bot_data.name,
            bot_data.namespace,
            bot_data.system_prompt or "",
            bot_data.mcp_servers or {},
            bot_data.skills or [],
        )
        ghost_name = ghost.name

        # Determine model reference
        model_ref_name = None
        model_ref_namespace = bot_data.namespace

        if bot_data.agent_config:
            if _is_predefined_model(bot_data.agent_config):
                # Reference existing public model
                model_ref_name = bot_data.agent_config.get("bind_model")
                model_ref_namespace = bot_data.agent_config.get(
                    "bind_model_namespace", "default"
                )

                # Validate the referenced model exists as public
                model = (
                    db.query(Kind)
                    .filter(
                        Kind.user_id == 0,
                        Kind.kind == "Model",
                        Kind.name == model_ref_name,
                        Kind.namespace == model_ref_namespace,
                        Kind.is_active == True,
                    )
                    .first()
                )
                if not model:
                    raise HTTPException(
                        status_code=status.HTTP_400_BAD_REQUEST,
                        detail=f"Model '{model_ref_namespace}/{model_ref_name}' is not a public resource.",
                    )
            else:
                # Create custom model
                created_model = _create_public_model(
                    db, bot_data.name, bot_data.namespace, bot_data.agent_config
                )
                if created_model:
                    model_ref_name = created_model.name
                    model_ref_namespace = created_model.namespace

        # Build bot JSON
        bot_json = _build_bot_json_from_form_data(
            bot_data.name,
            bot_data.namespace,
            bot_data.shell_name,
            shell_namespace,
            ghost_name,
            model_ref_name,
            model_ref_namespace,
        )
    else:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Either 'json' (bot_json) or 'shell_name' must be provided",
        )

    new_bot = Kind(
        user_id=0,
        kind="Bot",
        name=bot_data.name,
        namespace=bot_data.namespace,
        json=bot_json,
        is_active=True,
    )
    db.add(new_bot)
    db.commit()
    db.refresh(new_bot)

    return _bot_to_response(new_bot, db)


@router.put("/public-bots/{bot_id}", response_model=PublicBotResponse)
async def update_public_bot(
    bot_data: PublicBotUpdate,
    bot_id: int = Path(..., description="Bot ID"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin_user),
):
    """
    Update a public bot (admin only).

    Supports two modes:
    1. Raw JSON mode: Provide bot_json directly. All referenced resources must be public.
    2. Form data mode: Provide shell_name, system_prompt, mcp_servers, skills, agent_config.
       Ghost and Model will be auto-updated as public resources.
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
    new_name = bot_data.name if bot_data.name else bot.name
    new_namespace = bot_data.namespace if bot_data.namespace else bot.namespace

    if bot_data.name and bot_data.name != bot.name:
        existing_bot = (
            db.query(Kind)
            .filter(
                Kind.user_id == 0,
                Kind.kind == "Bot",
                Kind.name == bot_data.name,
                Kind.namespace == new_namespace,
            )
            .first()
        )
        if existing_bot:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Public bot '{bot_data.name}' already exists in namespace '{new_namespace}'",
            )

    # Determine which mode to use
    if bot_data.bot_json:
        # Raw JSON mode - validate resource references
        is_valid, error_message = _validate_bot_resource_references(
            db, bot_data.bot_json
        )
        if not is_valid:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=error_message,
            )
        bot.json = bot_data.bot_json
    elif (
        bot_data.shell_name is not None
        or bot_data.system_prompt is not None
        or bot_data.mcp_servers is not None
        or bot_data.skills is not None
        or bot_data.agent_config is not None
    ):
        # Form data mode - auto-update Ghost and optionally Model
        logger.info(f"Updating public bot '{new_name}' in form data mode")

        # Get current bot spec
        current_spec = bot.json.get("spec", {}) if bot.json else {}
        current_ghost_ref = current_spec.get("ghostRef", {})
        current_shell_ref = current_spec.get("shellRef", {})
        current_model_ref = current_spec.get("modelRef")

        # Determine shell reference
        shell_name = (
            bot_data.shell_name
            if bot_data.shell_name
            else current_shell_ref.get("name")
        )
        shell_namespace = current_shell_ref.get("namespace", "default")

        if bot_data.shell_name:
            # Validate new shell exists as public resource
            shell = (
                db.query(Kind)
                .filter(
                    Kind.user_id == 0,
                    Kind.kind == "Shell",
                    Kind.name == bot_data.shell_name,
                    Kind.is_active == True,
                )
                .first()
            )
            if not shell:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail=f"Shell '{bot_data.shell_name}' is not a public resource.",
                )
            shell_namespace = shell.namespace

        # Update Ghost if any ghost-related fields are provided
        ghost_name = current_ghost_ref.get("name", f"{new_name}-ghost")
        if (
            bot_data.system_prompt is not None
            or bot_data.mcp_servers is not None
            or bot_data.skills is not None
        ):
            # Get existing ghost to preserve unchanged fields
            existing_ghost = (
                db.query(Kind)
                .filter(
                    Kind.user_id == 0,
                    Kind.kind == "Ghost",
                    Kind.name == ghost_name,
                    Kind.namespace == new_namespace,
                )
                .first()
            )

            if existing_ghost:
                ghost_crd = Ghost.model_validate(existing_ghost.json)
                if bot_data.system_prompt is not None:
                    ghost_crd.spec.systemPrompt = bot_data.system_prompt
                if bot_data.mcp_servers is not None:
                    ghost_crd.spec.mcpServers = bot_data.mcp_servers
                if bot_data.skills is not None:
                    ghost_crd.spec.skills = bot_data.skills
                existing_ghost.json = ghost_crd.model_dump()
                flag_modified(existing_ghost, "json")
            else:
                # Create new ghost
                ghost = _create_public_ghost(
                    db,
                    new_name,
                    new_namespace,
                    bot_data.system_prompt or "",
                    bot_data.mcp_servers or {},
                    bot_data.skills or [],
                )
                ghost_name = ghost.name

        # Determine model reference
        model_ref_name = current_model_ref.get("name") if current_model_ref else None
        model_ref_namespace = (
            current_model_ref.get("namespace", new_namespace)
            if current_model_ref
            else new_namespace
        )

        if bot_data.agent_config is not None:
            if _is_predefined_model(bot_data.agent_config):
                # Reference existing public model
                model_ref_name = bot_data.agent_config.get("bind_model")
                model_ref_namespace = bot_data.agent_config.get(
                    "bind_model_namespace", "default"
                )

                # Validate the referenced model exists as public
                model = (
                    db.query(Kind)
                    .filter(
                        Kind.user_id == 0,
                        Kind.kind == "Model",
                        Kind.name == model_ref_name,
                        Kind.namespace == model_ref_namespace,
                        Kind.is_active == True,
                    )
                    .first()
                )
                if not model:
                    raise HTTPException(
                        status_code=status.HTTP_400_BAD_REQUEST,
                        detail=f"Model '{model_ref_namespace}/{model_ref_name}' is not a public resource.",
                    )
            elif bot_data.agent_config:
                # Create or update custom model
                created_model = _create_public_model(
                    db, new_name, new_namespace, bot_data.agent_config
                )
                if created_model:
                    model_ref_name = created_model.name
                    model_ref_namespace = created_model.namespace
            else:
                # Empty agent_config means no model binding
                model_ref_name = None

        # Build updated bot JSON
        bot.json = _build_bot_json_from_form_data(
            new_name,
            new_namespace,
            shell_name,
            shell_namespace,
            ghost_name,
            model_ref_name,
            model_ref_namespace,
        )
        flag_modified(bot, "json")

    # Update basic fields
    if bot_data.name is not None:
        bot.name = bot_data.name
    if bot_data.namespace is not None:
        bot.namespace = bot_data.namespace
    if bot_data.is_active is not None:
        bot.is_active = bot_data.is_active

    db.commit()
    db.refresh(bot)

    return _bot_to_response(bot, db)


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
