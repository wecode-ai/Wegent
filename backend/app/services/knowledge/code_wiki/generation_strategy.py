# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Resolve a Code Wiki's orchestration strategy and deployment Team together."""

from dataclasses import dataclass
from enum import Enum
from typing import Optional

from app.core.wiki_config import (
    CodeWikiGenerationPolicy,
    CodeWikiTeamRef,
    default_code_wiki_generation_policy,
    wiki_settings,
)

GENERATION_STRATEGY_SPEC_KEY = "generationStrategy"
GENERATION_STRATEGY_EXT_KEY = "generationStrategy"

COORDINATOR_REVIEWED = "coordinator_reviewed"
LEGACY = "legacy"


class ReviewProtocol(str, Enum):
    """How a full rebuild decides whether to initialise the review loop."""

    PLAN_ONLY = "plan_only"
    TEAM_LEGACY = "team_legacy"


@dataclass(frozen=True)
class GenerationStrategyDefinition:
    """Stable execution semantics owned by code, not deployment configuration."""

    strategy_id: str
    revision: int
    review_protocol: ReviewProtocol
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
    COORDINATOR_REVIEWED: GenerationStrategyDefinition(
        strategy_id=COORDINATOR_REVIEWED,
        revision=1,
        review_protocol=ReviewProtocol.PLAN_ONLY,
    ),
    # Existing wikis did infer review behaviour from collaborationModel. Keeping
    # that rule under a non-selectable strategy preserves them without making it a
    # contract for newly created wikis.
    LEGACY: GenerationStrategyDefinition(
        strategy_id=LEGACY,
        revision=1,
        review_protocol=ReviewProtocol.TEAM_LEGACY,
        selectable=False,
    ),
}


def configured_policy() -> CodeWikiGenerationPolicy:
    """Return the explicit multi-strategy policy or its single-Team equivalent."""

    return (
        wiki_settings.CODE_WIKI_GENERATION_POLICY
        or default_code_wiki_generation_policy(wiki_settings.CODE_WIKI_TEAM_NAME)
    )


def strategy_for_new_wiki(requested_id: Optional[str] = None) -> str:
    """Choose and validate the strategy persisted on a newly created Code Wiki."""

    policy = configured_policy()
    strategy_id = (requested_id or policy.default_strategy).strip()
    resolved = _resolve(policy, strategy_id)
    if requested_id and not resolved.definition.selectable:
        raise ValueError(f"Code Wiki generation strategy '{strategy_id}' is internal")
    return resolved.strategy_id


def strategy_for_run(
    stored_id: Optional[str], requested_id: Optional[str] = None
) -> ResolvedGenerationStrategy:
    """Resolve a run override, the Wiki default, or the legacy fallback."""

    policy = configured_policy()
    strategy_id = (requested_id or stored_id or policy.legacy_fallback_strategy).strip()
    resolved = _resolve(policy, strategy_id)
    if requested_id and not resolved.definition.selectable:
        raise ValueError(f"Code Wiki generation strategy '{strategy_id}' is internal")
    return resolved


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
