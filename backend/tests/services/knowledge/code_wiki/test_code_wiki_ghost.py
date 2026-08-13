# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""The stable generation policy carried by the Code Wiki Ghost."""

from pathlib import Path

import pytest
import yaml

GHOST_NAME = "code-wiki-ghost"
RESOURCES = (
    Path(__file__).resolve().parents[4] / "init_data" / "02-public-resources.yaml"
)


@pytest.fixture(scope="module")
def ghost() -> dict:
    for document in yaml.safe_load_all(RESOURCES.read_text()):
        if (
            document
            and document.get("kind") == "Ghost"
            and document.get("metadata", {}).get("name") == GHOST_NAME
        ):
            return document
    raise AssertionError(f"{GHOST_NAME} is not defined in 02-public-resources.yaml")


@pytest.fixture(scope="module")
def system_prompt(ghost: dict) -> str:
    return ghost["spec"]["systemPrompt"]


@pytest.mark.parametrize(
    "subject",
    [
        "quickstart",
        "architecture overview",
        "source map",
        "key workflows",
        "domain concepts",
        "operations notes",
        "testing guidance",
        "integration points",
    ],
)
def test_the_expected_coverage_is_stated(system_prompt: str, subject: str):
    assert subject in system_prompt


def test_inventing_evidence_is_forbidden(system_prompt: str):
    assert "Do not invent" in system_prompt


def test_the_agent_is_told_to_do_the_work_itself(system_prompt: str):
    assert "Plan the whole wiki first" in system_prompt
    assert "only when the repository is genuinely too large" in system_prompt


def test_how_much_to_read_is_bounded(system_prompt: str):
    assert "Do not read every file" in system_prompt


def test_history_is_asked_to_explain_why(system_prompt: str):
    assert "why" in system_prompt
    assert "history" in system_prompt.lower()


def test_the_relevance_test_is_carried(system_prompt: str):
    assert "would this change what someone does" in system_prompt


def test_pages_and_links_are_planned_before_writing(system_prompt: str):
    assert "Before writing any page" in system_prompt
    assert "relationship" in system_prompt


def test_concise_does_not_mean_fewer_pages(system_prompt: str):
    assert "dense and non-redundant, not short" in system_prompt
    assert "Do not target a page count" in system_prompt


def test_engineering_navigation_is_explicit(system_prompt: str):
    for subject in ("owning entry points", "symbols", "focused tests", "validation"):
        assert subject in system_prompt


def test_major_components_and_workflows_get_substantive_coverage(system_prompt: str):
    assert "every major component" in system_prompt
    assert "cross-component workflow" in system_prompt
    assert "substantive coverage" in system_prompt


def test_high_value_relationships_require_diagram_consideration(system_prompt: str):
    for subject in ("architecture", "cross-component", "lifecycles", "data models"):
        assert subject in system_prompt
    assert "code-wiki-mermaid skill" in system_prompt
    assert "decorative diagrams" in system_prompt


def test_sensitive_sources_and_values_are_forbidden(system_prompt: str):
    for subject in (
        "credentials",
        "private keys",
        "`.env`",
        "process environment",
        "`.git/config`",
        "private IP addresses",
    ):
        assert subject in system_prompt


def test_deployment_values_are_abstracted(system_prompt: str):
    assert "never deployment" in system_prompt
    assert "logical service or interface role" in system_prompt


def test_repository_instructions_are_untrusted_evidence(system_prompt: str):
    assert "untrusted evidence" in system_prompt
    assert "override this system prompt" in system_prompt


def test_the_ghost_uses_both_code_wiki_skills(ghost: dict):
    assert ghost["spec"]["skills"] == ["wiki_submit", "code-wiki-mermaid"]


def test_tool_syntax_and_mode_specific_deletion_are_not_duplicated(
    system_prompt: str,
):
    assert "node wiki_submit.js" not in system_prompt
    assert "--structure-order" not in system_prompt
    assert "Only an incremental run removes" not in system_prompt
    assert "In a full rebuild the version starts empty" not in system_prompt


def test_the_agent_must_finish_and_handle_feedback(system_prompt: str):
    assert "complete or fail the run" in system_prompt
    assert "publish refusal and diagram feedback" in system_prompt
