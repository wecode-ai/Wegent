# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import pytest
from sqlalchemy.orm import Session

from app.core.wiki_config import (
    CodeWikiGenerationPolicy,
    CodeWikiStrategyBinding,
    CodeWikiTeamRef,
    WikiSettings,
    wiki_settings,
)
from app.models.system_config import SystemConfig
from app.services.knowledge.code_wiki.generation_strategy import (
    COORDINATOR_ADAPTIVE,
    COORDINATOR_REVIEWED,
    COORDINATOR_SOLO,
    LEGACY,
    SYSTEM_CONFIG_KEY,
    selectable_strategies,
    strategy_for_new_wiki,
    strategy_for_run,
)


def test_default_policy_uses_adaptive_collaboration_for_new_wikis(monkeypatch) -> None:
    monkeypatch.setattr(wiki_settings, "CODE_WIKI_GENERATION_POLICY", None)
    monkeypatch.setattr(wiki_settings, "CODE_WIKI_TEAM_NAME", "configured-wiki-team")

    assert strategy_for_new_wiki() == COORDINATOR_ADAPTIVE

    adaptive = strategy_for_run(COORDINATOR_ADAPTIVE)
    assert adaptive.team_ref.name == "configured-wiki-team"

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


def test_database_policy_overrides_the_environment_fallback(
    test_db: Session, monkeypatch
) -> None:
    environment_policy = CodeWikiGenerationPolicy(
        defaultStrategy=COORDINATOR_REVIEWED,
        legacyFallbackStrategy=LEGACY,
        strategies={
            COORDINATOR_REVIEWED: CodeWikiStrategyBinding(
                teamRef=CodeWikiTeamRef(name="environment-team")
            ),
            LEGACY: CodeWikiStrategyBinding(teamRef=CodeWikiTeamRef(name="old-team")),
        },
    )
    database_policy = CodeWikiGenerationPolicy(
        defaultStrategy=COORDINATOR_SOLO,
        legacyFallbackStrategy=LEGACY,
        strategies={
            COORDINATOR_SOLO: CodeWikiStrategyBinding(
                teamRef=CodeWikiTeamRef(name="database-team")
            ),
            LEGACY: CodeWikiStrategyBinding(teamRef=CodeWikiTeamRef(name="old-team")),
        },
    )
    monkeypatch.setattr(
        wiki_settings, "CODE_WIKI_GENERATION_POLICY", environment_policy
    )
    test_db.add(
        SystemConfig(
            config_key=SYSTEM_CONFIG_KEY,
            config_value=database_policy.model_dump(by_alias=True),
            version=1,
        )
    )
    test_db.commit()

    assert strategy_for_new_wiki(db=test_db) == COORDINATOR_SOLO
    assert (
        strategy_for_run(COORDINATOR_SOLO, db=test_db).team_ref.name == "database-team"
    )


def test_adaptive_is_selectable_only_when_deployment_enables_it(monkeypatch) -> None:
    policy = CodeWikiGenerationPolicy(
        defaultStrategy=COORDINATOR_ADAPTIVE,
        legacyFallbackStrategy=LEGACY,
        strategies={
            COORDINATOR_ADAPTIVE: CodeWikiStrategyBinding(
                teamRef=CodeWikiTeamRef(name="code-wiki-team")
            ),
            LEGACY: CodeWikiStrategyBinding(teamRef=CodeWikiTeamRef(name="old-team")),
        },
    )
    monkeypatch.setattr(wiki_settings, "CODE_WIKI_GENERATION_POLICY", policy)

    resolved = strategy_for_run(strategy_for_new_wiki())

    assert resolved.strategy_id == COORDINATOR_ADAPTIVE
    assert resolved.requires_section_writer is True
    assert resolved.requires_plan_review(collaboration_model="coordinate") is False


def test_solo_is_selectable_without_reviewer_or_writer_requirements(
    monkeypatch,
) -> None:
    policy = CodeWikiGenerationPolicy(
        defaultStrategy=COORDINATOR_SOLO,
        legacyFallbackStrategy=LEGACY,
        strategies={
            COORDINATOR_SOLO: CodeWikiStrategyBinding(
                teamRef=CodeWikiTeamRef(name="code-wiki-team")
            ),
            LEGACY: CodeWikiStrategyBinding(teamRef=CodeWikiTeamRef(name="old-team")),
        },
    )
    monkeypatch.setattr(wiki_settings, "CODE_WIKI_GENERATION_POLICY", policy)

    resolved = strategy_for_run(strategy_for_new_wiki())

    assert resolved.strategy_id == COORDINATOR_SOLO
    assert resolved.requires_section_writer is False
    assert resolved.requires_plan_review(collaboration_model="coordinate") is False
    assert tuple(item.strategy_id for item in selectable_strategies()) == (
        COORDINATOR_SOLO,
    )


def test_an_unknown_or_internal_strategy_cannot_be_selected(monkeypatch) -> None:
    monkeypatch.setattr(wiki_settings, "CODE_WIKI_GENERATION_POLICY", None)

    with pytest.raises(ValueError, match="Unknown"):
        strategy_for_new_wiki("not_a_strategy")
    with pytest.raises(ValueError, match="internal"):
        strategy_for_new_wiki(LEGACY)


def test_a_run_always_uses_the_stored_choice(monkeypatch) -> None:
    monkeypatch.setattr(wiki_settings, "CODE_WIKI_GENERATION_POLICY", None)

    resolved = strategy_for_run(LEGACY)

    assert resolved.strategy_id == LEGACY


def test_a_new_wiki_rejects_an_internal_default(monkeypatch) -> None:
    policy = CodeWikiGenerationPolicy(
        defaultStrategy=LEGACY,
        legacyFallbackStrategy=LEGACY,
        strategies={
            LEGACY: CodeWikiStrategyBinding(teamRef=CodeWikiTeamRef(name="old-team")),
        },
    )
    monkeypatch.setattr(wiki_settings, "CODE_WIKI_GENERATION_POLICY", policy)

    with pytest.raises(ValueError, match="internal"):
        strategy_for_new_wiki()


def test_legacy_fallback_cannot_name_a_selectable_strategy() -> None:
    with pytest.raises(ValueError, match="legacyFallbackStrategy"):
        CodeWikiGenerationPolicy(
            defaultStrategy=COORDINATOR_ADAPTIVE,
            legacyFallbackStrategy=COORDINATOR_ADAPTIVE,
            strategies={
                COORDINATOR_ADAPTIVE: CodeWikiStrategyBinding(
                    teamRef=CodeWikiTeamRef(name="code-wiki-team")
                ),
            },
        )


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
