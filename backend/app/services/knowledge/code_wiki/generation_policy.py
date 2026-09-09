# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Persisted Code Wiki generation-policy operations."""

from dataclasses import dataclass
from typing import Mapping, Optional

from sqlalchemy.orm import Session

from app.core.wiki_config import CodeWikiGenerationPolicy, CodeWikiStrategyBinding
from app.models.system_config import SystemConfig
from app.models.user import User
from app.services.knowledge.code_wiki.generation_strategy import (
    LEGACY,
    SYSTEM_CONFIG_KEY,
    ResolvedGenerationStrategy,
    configured_policy,
    definition_for,
    selectable_definitions,
    strategy_for_new_wiki,
    strategy_for_run,
)
from app.services.knowledge.code_wiki.runner import strategy_team_readiness_many


@dataclass(frozen=True)
class StoredGenerationPolicy:
    """A policy plus the persistence metadata the administrator UI needs."""

    policy: CodeWikiGenerationPolicy
    version: int
    configured: bool


def stored_generation_policy(db: Session) -> StoredGenerationPolicy:
    """Load the stored policy, falling back to deployment wiring when absent."""
    config = (
        db.query(SystemConfig)
        .filter(SystemConfig.config_key == SYSTEM_CONFIG_KEY)
        .first()
    )
    return StoredGenerationPolicy(
        policy=configured_policy(db),
        version=config.version if config is not None else 0,
        configured=config is not None,
    )


def save_generation_policy(
    db: Session,
    *,
    user: User,
    default_strategy: str,
    bindings: Mapping[str, CodeWikiStrategyBinding],
) -> StoredGenerationPolicy:
    """Validate and replace the selectable policy bindings in one transaction."""
    definitions = {definition.strategy_id for definition in selectable_definitions()}
    if set(bindings) != definitions:
        raise ValueError(
            "Every registered Code Wiki generation strategy must be configured"
        )
    if default_strategy not in definitions:
        raise ValueError("The default Code Wiki generation strategy is unknown")
    if not bindings[default_strategy].enabled:
        raise ValueError("The default Code Wiki generation strategy must be enabled")

    legacy_binding = configured_policy(db).strategies[LEGACY]
    policy = CodeWikiGenerationPolicy(
        defaultStrategy=default_strategy,
        legacyFallbackStrategy=LEGACY,
        strategies={**bindings, LEGACY: legacy_binding},
    )
    strategies = tuple(
        ResolvedGenerationStrategy(
            definition=definition_for(strategy_id), team_ref=binding.team_ref
        )
        for strategy_id, binding in bindings.items()
        if binding.enabled
    )
    for strategy, reason in strategy_team_readiness_many(db, user, strategies).items():
        if reason:
            raise ValueError(f"{strategy}: {reason}")

    config = (
        db.query(SystemConfig)
        .filter(SystemConfig.config_key == SYSTEM_CONFIG_KEY)
        .first()
    )
    if config is None:
        config = SystemConfig(
            config_key=SYSTEM_CONFIG_KEY,
            config_value=policy.model_dump(by_alias=True),
            version=1,
            updated_by=user.id,
        )
        db.add(config)
    else:
        config.config_value = policy.model_dump(by_alias=True)
        config.version += 1
        config.updated_by = user.id
    db.commit()
    return StoredGenerationPolicy(
        policy=policy, version=config.version, configured=True
    )


def ready_strategy_for_new_wiki(
    db: Session, *, user: User, requested_id: Optional[str]
) -> str:
    """Resolve a selectable strategy and reject a choice whose Team cannot run."""
    strategy_id = strategy_for_new_wiki(requested_id, db=db)
    # A blank field preserves the existing deployment-default bootstrap behaviour:
    # creation remains possible before public Teams have been loaded, and its first
    # run reports the same actionable Team error it always did. An explicit API/UI
    # choice, however, must never persist a strategy the caller cannot run.
    if not requested_id:
        return strategy_id
    strategy = strategy_for_run(strategy_id, db=db)
    reason = strategy_team_readiness_many(db, user, (strategy,))[strategy_id]
    if reason:
        raise ValueError(
            f"Code Wiki generation strategy '{strategy_id}' is unavailable: {reason}"
        )
    return strategy_id


def ready_selectable_strategies(
    db: Session, *, user: User
) -> tuple[tuple[ResolvedGenerationStrategy, ...], Mapping[str, str]]:
    """Return selectable strategies and any per-strategy readiness failure."""
    from app.services.knowledge.code_wiki.generation_strategy import (
        selectable_strategies,
    )

    strategies = selectable_strategies(db)
    readiness = strategy_team_readiness_many(db, user, strategies)
    return strategies, readiness
