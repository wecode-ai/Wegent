# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Resolve a Code Wiki's orchestration strategy and deployment Team together."""

from dataclasses import dataclass
from enum import Enum
from typing import Optional

from sqlalchemy.orm import Session

from app.core.wiki_config import (
    CodeWikiGenerationPolicy,
    CodeWikiTeamRef,
    default_code_wiki_generation_policy,
    wiki_settings,
)
from app.models.system_config import SystemConfig

GENERATION_STRATEGY_SPEC_KEY = "generationStrategy"
GENERATION_STRATEGY_EXT_KEY = "generationStrategy"

COORDINATOR_ADAPTIVE = "coordinator_adaptive"
COORDINATOR_REVIEWED = "coordinator_reviewed"
COORDINATOR_SOLO = "coordinator_solo"
LEGACY = "legacy"
SYSTEM_CONFIG_KEY = "code_wiki_generation_policy"


class ReviewProtocol(str, Enum):
    """How a full rebuild decides whether to initialise the review loop."""

    NONE = "none"
    PLAN_ONLY = "plan_only"
    TEAM_LEGACY = "team_legacy"


@dataclass(frozen=True)
class GenerationStrategyDefinition:
    """Stable execution semantics owned by code, not deployment configuration."""

    strategy_id: str
    revision: int
    display_name: str
    description: str
    review_protocol: ReviewProtocol
    requires_section_writer: bool = False
    selectable: bool = True


@dataclass(frozen=True)
class ResolvedGenerationStrategy:
    """One strategy joined with the Team selected by deployment policy."""

    definition: GenerationStrategyDefinition
    team_ref: CodeWikiTeamRef

    @property
    def strategy_id(self) -> str:
        return self.definition.strategy_id

    @property
    def revision(self) -> int:
        return self.definition.revision

    def requires_plan_review(self, *, collaboration_model: str) -> bool:
        if self.definition.review_protocol is ReviewProtocol.TEAM_LEGACY:
            return collaboration_model == "coordinate"
        return self.definition.review_protocol is ReviewProtocol.PLAN_ONLY

    @property
    def requires_section_writer(self) -> bool:
        return self.definition.requires_section_writer

    def snapshot(self) -> dict:
        return {
            "id": self.strategy_id,
            "revision": self.revision,
            "teamRef": {
                "name": self.team_ref.name,
                "namespace": self.team_ref.namespace,
            },
        }


_DEFINITIONS = {
    COORDINATOR_ADAPTIVE: GenerationStrategyDefinition(
        strategy_id=COORDINATOR_ADAPTIVE,
        revision=1,
        display_name="Adaptive coordinator",
        description="Coordinator writes known scopes and delegates deeper work packages.",
        review_protocol=ReviewProtocol.NONE,
        requires_section_writer=True,
    ),
    COORDINATOR_REVIEWED: GenerationStrategyDefinition(
        strategy_id=COORDINATOR_REVIEWED,
        revision=1,
        display_name="Reviewed coordinator",
        description="Coordinator follows the persisted plan review before writing.",
        review_protocol=ReviewProtocol.PLAN_ONLY,
    ),
    COORDINATOR_SOLO: GenerationStrategyDefinition(
        strategy_id=COORDINATOR_SOLO,
        revision=1,
        display_name="Solo coordinator",
        description="Coordinator researches and writes every page without subagents or review.",
        review_protocol=ReviewProtocol.NONE,
    ),
    # Existing wikis did infer review behaviour from collaborationModel. Keeping
    # that rule under a non-selectable strategy preserves them without making it a
    # contract for newly created wikis.
    LEGACY: GenerationStrategyDefinition(
        strategy_id=LEGACY,
        revision=1,
        display_name="Legacy",
        description="Compatibility behaviour for wikis created before strategy selection.",
        review_protocol=ReviewProtocol.TEAM_LEGACY,
        selectable=False,
    ),
}


def configured_policy(db: Optional[Session] = None) -> CodeWikiGenerationPolicy:
    """Return the administrator-managed policy, or the deployment compatibility fallback."""

    if db is not None:
        config = (
            db.query(SystemConfig)
            .filter(SystemConfig.config_key == SYSTEM_CONFIG_KEY)
            .first()
        )
        if config is not None:
            return CodeWikiGenerationPolicy.model_validate(config.config_value)
    return (
        wiki_settings.CODE_WIKI_GENERATION_POLICY
        or default_code_wiki_generation_policy(wiki_settings.CODE_WIKI_TEAM_NAME)
    )


def strategy_for_new_wiki(
    requested_id: Optional[str] = None, *, db: Optional[Session] = None
) -> str:
    """Choose and validate the strategy persisted on a newly created Code Wiki."""

    policy = configured_policy(db)
    strategy_id = (requested_id or policy.default_strategy).strip()
    resolved = _resolve(policy, strategy_id)
    if not resolved.definition.selectable:
        raise ValueError(f"Code Wiki generation strategy '{strategy_id}' is internal")
    return resolved.strategy_id


def selectable_strategies(
    db: Optional[Session] = None,
) -> tuple[ResolvedGenerationStrategy, ...]:
    """The policy-enabled strategies a caller may choose for a Code Wiki."""
    policy = configured_policy(db)
    return tuple(
        resolved
        for strategy_id in _DEFINITIONS
        if (resolved := _resolve_if_enabled(policy, strategy_id)) is not None
        and resolved.definition.selectable
    )


def strategy_for_run(
    stored_id: Optional[str], *, db: Optional[Session] = None
) -> ResolvedGenerationStrategy:
    """Resolve the Wiki default, or the legacy fallback for an older Wiki."""

    policy = configured_policy(db)
    strategy_id = (stored_id or policy.legacy_fallback_strategy).strip()
    return _resolve(policy, strategy_id)


def selectable_definitions() -> tuple[GenerationStrategyDefinition, ...]:
    """Stable selectable strategy definitions for the administrator configuration UI."""

    return tuple(
        definition for definition in _DEFINITIONS.values() if definition.selectable
    )


def definition_for(strategy_id: str) -> GenerationStrategyDefinition:
    """Return one registered strategy definition for administrator validation."""

    definition = _DEFINITIONS.get(strategy_id)
    if definition is None:
        raise ValueError(f"Unknown Code Wiki generation strategy '{strategy_id}'")
    return definition


def _resolve(
    policy: CodeWikiGenerationPolicy, strategy_id: str
) -> ResolvedGenerationStrategy:
    definition = _DEFINITIONS.get(strategy_id)
    if definition is None:
        raise ValueError(f"Unknown Code Wiki generation strategy '{strategy_id}'")
    binding = policy.strategies.get(strategy_id)
    if binding is None or not binding.enabled:
        raise ValueError(
            f"Code Wiki generation strategy '{strategy_id}' is not enabled"
        )
    return ResolvedGenerationStrategy(definition=definition, team_ref=binding.team_ref)


def _resolve_if_enabled(
    policy: CodeWikiGenerationPolicy, strategy_id: str
) -> Optional[ResolvedGenerationStrategy]:
    binding = policy.strategies.get(strategy_id)
    if binding is None or not binding.enabled:
        return None
    definition = _DEFINITIONS.get(strategy_id)
    if definition is None:
        return None
    return ResolvedGenerationStrategy(definition=definition, team_ref=binding.team_ref)
