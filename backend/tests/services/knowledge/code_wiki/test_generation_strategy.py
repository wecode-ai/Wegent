# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import pytest

from app.core.wiki_config import (
    CodeWikiGenerationPolicy,
    CodeWikiStrategyBinding,
    CodeWikiTeamRef,
    WikiSettings,
    wiki_settings,
)
from app.services.knowledge.code_wiki.generation_strategy import (
    COORDINATOR_ADAPTIVE,
    COORDINATOR_REVIEWED,
    LEGACY,
    strategy_for_new_wiki,
    strategy_for_run,
)


def test_default_policy_preserves_single_team_behaviour(monkeypatch) -> None:
    monkeypatch.setattr(wiki_settings, "CODE_WIKI_GENERATION_POLICY", None)
    monkeypatch.setattr(wiki_settings, "CODE_WIKI_TEAM_NAME", "configured-wiki-team")

    assert strategy_for_new_wiki() == LEGACY

    legacy = strategy_for_run(None)
    assert legacy.strategy_id == LEGACY
    assert legacy.team_ref.name == "configured-wiki-team"


def test_explicit_policy_owns_the_team_mapping(monkeypatch) -> None:
    policy = CodeWikiGenerationPolicy(
        defaultStrategy=COORDINATOR_REVIEWED,
        legacyFallbackStrategy=LEGACY,
        strategies={
            COORDINATOR_REVIEWED: CodeWikiStrategyBinding(
                teamRef=CodeWikiTeamRef(name="reviewed-team", namespace="system")
            ),
            LEGACY: CodeWikiStrategyBinding(teamRef=CodeWikiTeamRef(name="old-team")),
        },
    )
    monkeypatch.setattr(wiki_settings, "CODE_WIKI_GENERATION_POLICY", policy)

    resolved = strategy_for_run(COORDINATOR_REVIEWED)

    assert resolved.team_ref.name == "reviewed-team"
    assert resolved.team_ref.namespace == "system"
    assert resolved.snapshot() == {
        "id": COORDINATOR_REVIEWED,
        "revision": 1,
        "teamRef": {"name": "reviewed-team", "namespace": "system"},
    }


def test_adaptive_is_selectable_only_when_deployment_enables_it(monkeypatch) -> None:
    policy = CodeWikiGenerationPolicy(
        defaultStrategy=COORDINATOR_ADAPTIVE,
        legacyFallbackStrategy=LEGACY,
        strategies={
            COORDINATOR_ADAPTIVE: CodeWikiStrategyBinding(
                teamRef=CodeWikiTeamRef(name="code-wiki-adaptive-team")
            ),
            LEGACY: CodeWikiStrategyBinding(teamRef=CodeWikiTeamRef(name="old-team")),
        },
    )
    monkeypatch.setattr(wiki_settings, "CODE_WIKI_GENERATION_POLICY", policy)

    resolved = strategy_for_run(strategy_for_new_wiki())

    assert resolved.strategy_id == COORDINATOR_ADAPTIVE
    assert resolved.requires_section_writer is True
    assert resolved.requires_plan_review(collaboration_model="coordinate") is False


def test_an_unknown_or_internal_strategy_cannot_be_selected(monkeypatch) -> None:
    monkeypatch.setattr(wiki_settings, "CODE_WIKI_GENERATION_POLICY", None)

    with pytest.raises(ValueError, match="Unknown"):
        strategy_for_new_wiki("not_a_strategy")
    with pytest.raises(ValueError, match="internal"):
        strategy_for_new_wiki(LEGACY)


def test_a_run_override_wins_without_changing_the_stored_choice(monkeypatch) -> None:
    monkeypatch.setattr(wiki_settings, "CODE_WIKI_GENERATION_POLICY", None)

    resolved = strategy_for_run(LEGACY, COORDINATOR_REVIEWED)

    assert resolved.strategy_id == COORDINATOR_REVIEWED


def test_policy_defaults_must_name_enabled_bindings() -> None:
    with pytest.raises(ValueError, match="defaultStrategy"):
        CodeWikiGenerationPolicy(
            defaultStrategy=COORDINATOR_REVIEWED,
            legacyFallbackStrategy=LEGACY,
            strategies={
                COORDINATOR_REVIEWED: CodeWikiStrategyBinding(
                    enabled=False,
                    teamRef=CodeWikiTeamRef(name="reviewed-team"),
                ),
                LEGACY: CodeWikiStrategyBinding(
                    teamRef=CodeWikiTeamRef(name="old-team")
                ),
            },
        )


def test_structured_policy_is_loaded_from_one_environment_setting(monkeypatch) -> None:
    monkeypatch.setenv(
        "WIKI_CODE_WIKI_GENERATION_POLICY",
        """{
          "defaultStrategy": "coordinator_reviewed",
          "legacyFallbackStrategy": "legacy",
          "strategies": {
            "coordinator_reviewed": {
              "teamRef": {"name": "reviewed-team", "namespace": "system"}
            },
            "legacy": {"teamRef": {"name": "old-team"}}
          }
        }""",
    )

    settings = WikiSettings(_env_file=None)

    assert settings.CODE_WIKI_GENERATION_POLICY is not None
    binding = settings.CODE_WIKI_GENERATION_POLICY.strategies[COORDINATOR_REVIEWED]
    assert binding.team_ref.name == "reviewed-team"
    assert binding.team_ref.namespace == "system"
