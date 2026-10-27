# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Model selection and authorization shared by execution and resource discovery."""

import logging
from typing import Any, Dict, Optional

from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.user import User
from app.schemas.kind import Bot
from app.services.adapters.public_model import is_public_model_allowed_for_user
from app.services.capability_lookup import ExecutionCapabilityLookup

logger = logging.getLogger(__name__)


class PublicModelAccessDeniedError(ValueError):
    """Raised when a public model's user whitelist rejects the current user."""


def _resolve_model_for_bot(
    db: Session,
    bot: Kind,
    user_id: int,
    override_model_name: Optional[str] = None,
    force_override: bool = False,
    *,
    lookup: ExecutionCapabilityLookup | None = None,
) -> tuple[Optional[Kind], Optional[Dict[str, Any]], Optional[str], Dict[str, Any]]:
    """
    Resolve model Kind and spec for a bot.

    Shared logic for build_agent_config_for_bot and get_model_config_for_bot.

    Resolution priority:
    1. override_model_name with force_override=True (task-level override)
    2. bot.spec.agent_config.bind_model (bot-level binding)
    3. bot.spec.modelRef (legacy reference)
    4. override_model_name without force_override (fallback)

    Args:
        db: Database session
        bot: The Bot Kind object
        user_id: User ID for querying user-specific models
        override_model_name: Optional model name to override
        force_override: If True, override_model_name takes highest priority

    Returns:
        Tuple of (model_kind, model_spec, model_name, raw_agent_config).
        model_kind/model_spec/model_name may be None if no model is found.

    Raises:
        ValueError: If override_model_name is not in the bot's allowed_models whitelist.
    """
    bot_crd = Bot.model_validate(bot.json)
    bot_json = bot.json or {}
    bot_spec = bot_json.get("spec", {})
    raw_agent_config = bot_spec.get("agent_config", {})

    model_name = None

    # Priority 1: Force override from task
    # Tracks whether the resolved model was explicitly chosen by the user.
    # Bot-bound models that later become whitelist-restricted are reported as
    # "not found" (the user never picked them), while a user-selected model
    # keeps the informative whitelist error.
    model_from_user_override = False
    if force_override and override_model_name:
        model_name = override_model_name
        model_from_user_override = True
        logger.info(f"Using task model (force override): {model_name}")
    else:
        # Priority 2: Bot's agent_config.bind_model
        bind_model = raw_agent_config.get("bind_model")
        if bind_model and isinstance(bind_model, str) and bind_model.strip():
            model_name = bind_model.strip()
            logger.info(f"Using bot bound model: {model_name}")

        # Priority 3: Bot's modelRef (legacy)
        if not model_name and bot_crd.spec.modelRef:
            model_name = bot_crd.spec.modelRef.name
            logger.info(f"Using bot modelRef: {model_name}")

        # Priority 4: Task-level override (fallback)
        if not model_name and override_model_name:
            model_name = override_model_name
            model_from_user_override = True
            logger.info(f"Using task model (fallback): {model_name}")

    if not model_name:
        return None, None, None, raw_agent_config

    # Validate against allowed_models whitelist when an override model is used.
    # This is the single validation point covering all call paths (chat, task creation,
    # subscription, retry, etc.).
    if override_model_name:
        allowed_names = _resolve_allowed_model_names(
            db,
            bot_crd=bot_crd,
            raw_agent_config=raw_agent_config,
            user_id=user_id,
            lookup=lookup,
        )
        if allowed_names is not None:
            if model_name not in allowed_names:
                raise ValueError(
                    f"Model '{model_name}' is not in the allowed models list "
                    f"for bot '{bot.name}'"
                )
            logger.info(
                "Model '%s' passed allowed_models whitelist check for bot '%s'",
                model_name,
                bot.name,
            )

    # Find the model Kind object, following any bind_model pointer chain
    # (e.g. a Bot's private Model that only carries an allowed_models
    # whitelist and points onward to the model with the real env config).
    try:
        lookup_options = {"lookup": lookup} if lookup is not None else {}
        model_kind, model_spec = _find_model_with_namespace(
            db, model_name, user_id, **lookup_options
        )
        model_kind, model_spec = _resolve_bind_model_pointer(
            db, user_id, model_kind, model_spec, **lookup_options
        )
    except PublicModelAccessDeniedError:
        if model_from_user_override:
            raise
        # The bot's bound model became whitelist-restricted after it was
        # configured. From this user's perspective the model is unusable, so
        # treat it exactly like a model that no longer exists.
        logger.warning(
            f"Bot bound model '{model_name}' is not available to user_id={user_id} "
            f"(public model whitelist); treating it as not found"
        )
        model_kind, model_spec = None, None
    return model_kind, model_spec, model_name, raw_agent_config


def _resolve_allowed_model_names(
    db: Session,
    *,
    bot_crd: Bot,
    raw_agent_config: Dict[str, Any],
    user_id: int,
    lookup: ExecutionCapabilityLookup | None = None,
) -> Optional[set[str]]:
    """Resolve the model names a bot allows.

    The whitelist lives either on the bot's agent_config or, for bots that bind
    a Model carrying only the restriction, on that Model's modelConfig. Bound
    Models are read in the same priority order as the model selection itself
    (agent_config.bind_model, then the legacy spec.modelRef).

    Returns None when the bot does not restrict models. An absent or empty
    allowed_models list means "no restriction" (the settings UI only writes the
    key once at least one model is allowed), while an empty set means a
    whitelist is configured but declares no usable entry, which blocks every
    override.
    """
    allowed_models = raw_agent_config.get("allowed_models")
    if not allowed_models:
        for bound_model_name in _bound_model_names(bot_crd, raw_agent_config):
            # Only inspect the bound model's metadata here; the user is not
            # executing with it, so the public-model user whitelist must not
            # apply. Otherwise overriding away from a whitelist-restricted
            # bound model would still fail with that model's whitelist error.
            _, bound_model_spec = _find_model_with_namespace(
                db,
                bound_model_name,
                user_id,
                enforce_public_whitelist=False,
                **({"lookup": lookup} if lookup is not None else {}),
            )
            if not bound_model_spec:
                continue
            bound_model_config = bound_model_spec.get("modelConfig", {})
            if not isinstance(bound_model_config, dict):
                continue
            bound_allowed_models = bound_model_config.get("allowed_models")
            if bound_allowed_models:
                allowed_models = bound_allowed_models
                break

    if not isinstance(allowed_models, list) or not allowed_models:
        return None

    return {
        m.get("name") for m in allowed_models if isinstance(m, dict) and m.get("name")
    }


def _bound_model_names(bot_crd: Bot, raw_agent_config: Dict[str, Any]) -> list[str]:
    """Return models a bot binds, ordered like the model selection priority."""
    bound_model_names: list[str] = []

    bind_model = raw_agent_config.get("bind_model")
    if isinstance(bind_model, str) and bind_model.strip():
        bound_model_names.append(bind_model.strip())

    model_ref = bot_crd.spec.modelRef
    if model_ref and model_ref.name not in bound_model_names:
        bound_model_names.append(model_ref.name)

    return bound_model_names


def allowed_model_names_for_bot(
    db: Session,
    bot: Kind,
    user_id: int,
) -> Optional[set[str]]:
    """Return the model names a bot allows, or None when it allows everything."""
    bot_json = bot.json if isinstance(bot.json, dict) else {}
    bot_crd = Bot.model_validate(bot_json)
    bot_spec = bot_json.get("spec") or {}
    raw_agent_config = bot_spec.get("agent_config") or {}
    if not isinstance(raw_agent_config, dict):
        raw_agent_config = {}
    return _resolve_allowed_model_names(
        db,
        bot_crd=bot_crd,
        raw_agent_config=raw_agent_config,
        user_id=user_id,
    )


def allowed_model_names_for_team(
    db: Session,
    team: Kind,
    user_id: int,
) -> Optional[set[str]]:
    """Return the model names every bot of a team allows.

    A model override is applied to every bot of the team, so it has to satisfy
    each bot's restriction. Returns None when the team JSON is unavailable or
    no bot restricts models; an empty set means no model satisfies the team.
    """
    from app.schemas.kind import Team
    from app.services.readers import KindType, kindReader

    team_json = getattr(team, "json", None)
    if not isinstance(team_json, dict):
        return None

    team_crd = Team.model_validate(team_json)
    team_user_id = team.user_id or user_id
    allowed_names: Optional[set[str]] = None

    for member in team_crd.spec.members or []:
        bot = kindReader.get_by_name_and_namespace(
            db,
            team_user_id,
            KindType.BOT,
            member.botRef.namespace,
            member.botRef.name,
        )
        if bot is None:
            continue
        bot_allowed_names = allowed_model_names_for_bot(db, bot, user_id)
        if bot_allowed_names is None:
            continue
        allowed_names = (
            bot_allowed_names
            if allowed_names is None
            else allowed_names & bot_allowed_names
        )

    return allowed_names


def resolve_model_name_for_bot(
    db: Session,
    bot: Kind,
    user_id: int,
) -> Optional[str]:
    """Return the Bot's configured Model resource name."""

    _, _, model_name, _ = _resolve_model_for_bot(db, bot, user_id)
    return model_name


def _find_model(db: Session, model_name: str, user_id: int) -> Optional[Dict[str, Any]]:
    """
    Find model by name.

    Search order:
    1. User's private models (kinds table)
    2. Group models (kinds table in user's groups)
    3. Public models (kinds table with user_id=0)
    4. Runtime-only models derived from user execution config

    Args:
        db: Database session
        model_name: Model name to find
        user_id: User ID for private model lookup

    Returns:
        Model spec dictionary or None if not found
    """
    model_kind, model_spec = _find_model_with_namespace(db, model_name, user_id)
    return model_spec


def _find_model_with_namespace(
    db: Session,
    model_name: str,
    user_id: int,
    enforce_public_whitelist: bool = True,
    *,
    lookup: ExecutionCapabilityLookup | None = None,
) -> tuple[Optional[Kind], Optional[Dict[str, Any]]]:
    """
    Find model by name and return both the Kind object and spec.

    Search order:
    1. User's private models (kinds table)
    2. Group models (kinds table in user's groups)
    3. Public models (kinds table with user_id=0)
    4. Runtime-only models derived from user execution config

    Args:
        db: Database session
        model_name: Model name to find
        user_id: User ID for private model lookup
        enforce_public_whitelist: When False, skip the public model user
            whitelist check. Only used by callers that read a model's metadata
            (e.g. an agent's bound model) without executing with it.

    Returns:
        Tuple of (Kind object, Model spec dictionary) or (None, None) if not found
    """
    lookup = lookup or ExecutionCapabilityLookup(db, user_id)
    if lookup.db is not db or lookup.user_id != user_id:
        raise ValueError("Model lookup belongs to a different execution identity")
    user_model = lookup.personal("Model", model_name)

    if user_model and user_model.json:
        logger.info(
            "Found model '%s' in user's private models (namespace: %s)",
            model_name,
            user_model.namespace,
        )
        return user_model, user_model.json.get("spec", {})

    referenced_model = lookup.referenced("Model", model_name, "default")
    if referenced_model and referenced_model.json:
        return referenced_model, referenced_model.json.get("spec", {})

    # Search group models
    user_groups = lookup.groups
    if user_groups:
        group_model = lookup.group("Model", model_name, user_groups)

        if group_model and group_model.json:
            logger.info(
                "Found model '%s' in group models (namespace: %s)",
                model_name,
                group_model.namespace,
            )
            return group_model, group_model.json.get("spec", {})
        for group_name in user_groups:
            referenced_model = lookup.referenced("Model", model_name, group_name)
            if referenced_model and referenced_model.json:
                return referenced_model, referenced_model.json.get("spec", {})

    # Search public models
    public_model = lookup.public("Model", model_name)

    if public_model and public_model.json:
        # Enforce the public model user whitelist: only listed users may use it.
        user = db.get(User, user_id)
        if enforce_public_whitelist and not is_public_model_allowed_for_user(
            public_model.json, user.user_name if user else None
        ):
            raise PublicModelAccessDeniedError(
                f"Model '{model_name}' is restricted to whitelisted users"
            )
        logger.info(
            "Found model '%s' in public models (namespace: %s)",
            model_name,
            public_model.namespace,
        )
        return public_model, public_model.json.get("spec", {})

    runtime_model_spec = lookup.runtime_model(model_name)
    if runtime_model_spec:
        logger.info("Found model '%s' as runtime-only Codex model", model_name)
        return None, runtime_model_spec

    logger.warning(f"Model '{model_name}' not found in any source")
    return None, None


_MAX_BIND_MODEL_POINTER_DEPTH = 5


def _resolve_bind_model_pointer(
    db: Session,
    user_id: int,
    model_kind: Optional[Kind],
    model_spec: Optional[Dict[str, Any]],
    *,
    lookup: ExecutionCapabilityLookup | None = None,
) -> tuple[Optional[Kind], Optional[Dict[str, Any]]]:
    """
    Follow a Model's modelConfig.bind_model pointer to the Model it references.

    Some Models (e.g. a Bot's private Model created to carry a restricted
    allowed_models whitelist) only store {"bind_model": ..., "allowed_models": [...]}
    without their own "env" section - the actual provider config lives on the
    Model named by bind_model. Without this resolution, callers would silently
    fall back to placeholder defaults (gpt-4 / empty api_key) instead of the
    real credentials.

    Args:
        db: Database session
        user_id: User ID for querying user-specific models
        model_kind: The Model Kind object to start from (may be None for
            runtime-only models)
        model_spec: The Model spec dict to start from

    Returns:
        Tuple of (model_kind, model_spec) once a Model with a real "env"
        section is reached, or the last unresolved (model_kind, model_spec)
        if there was no bind_model to follow.

    Raises:
        ValueError: If a bind_model pointer target cannot be found, or the
            pointer chain is too deep or cyclic.
    """
    visited: set[str] = set()
    while model_spec:
        model_config = model_spec.get("modelConfig") or {}
        if model_config.get("env"):
            return model_kind, model_spec

        bind_model = model_config.get("bind_model")
        if not isinstance(bind_model, str) or not bind_model.strip():
            return model_kind, model_spec
        bind_model = bind_model.strip()

        if bind_model in visited or len(visited) >= _MAX_BIND_MODEL_POINTER_DEPTH:
            raise ValueError(
                f"Model bind_model pointer chain is too deep or cyclic "
                f"while resolving '{bind_model}'"
            )
        visited.add(bind_model)

        current_name = model_kind.name if model_kind else bind_model
        logger.info(
            "[model_resolver] Model '%s' has no env, following bind_model "
            "pointer to '%s'",
            current_name,
            bind_model,
        )
        next_kind, next_spec = _find_model_with_namespace(
            db,
            bind_model,
            user_id,
            **({"lookup": lookup} if lookup is not None else {}),
        )
        if not next_spec:
            raise ValueError(
                f"Model '{current_name}' binds to model '{bind_model}', "
                f"which was not found"
            )
        model_kind, model_spec = next_kind, next_spec

    return model_kind, model_spec
