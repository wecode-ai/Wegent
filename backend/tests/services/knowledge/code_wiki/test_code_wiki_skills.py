# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Contracts owned by the Code Wiki submission skill."""

from pathlib import Path

import yaml

SKILLS = Path(__file__).resolve().parents[4] / "init_data" / "skills"


def _skill(name: str) -> tuple[dict, str]:
    raw = (SKILLS / name / "SKILL.md").read_text()
    _, frontmatter, body = raw.split("---", 2)
    return yaml.safe_load(frontmatter), body


def _review_contract() -> str:
    return (SKILLS / "wiki_submit" / "REVIEW_CONTRACT.md").read_text()


def test_wiki_submit_owns_the_page_write_contract() -> None:
    metadata, body = _skill("wiki_submit")

    assert metadata["bindShells"] == ["ClaudeCode"]
    assert metadata["version"] == "2.0.4"
    for subject in (
        "at most 4 folders",
        "complete content",
        "section that holds pages needs a substantive page",
        "architecture/backend/api",
        "both `architecture` and `architecture/backend`",
        "at least two independent child pages",
        "Titles name the subject",
        "[Backend](architecture/backend)",
        "--structure-order",
        "version was published",
        "node IDs distinct from subgraph IDs",
        "validate-mermaid",
        "pinned Mermaid parser plus a matching guard",
        "exits with code 2",
        "publish gate is authoritative",
        "`complete` again",
        "Before the first submit",
        "Before ending the run",
        "Do not report the generation as complete",
        "full-rebuild review checkpoint",
        "REVIEW_CONTRACT.md",
        "review-open",
        "review-status",
        "`nextAction`",
        "handoff-file",
        "writing-plan-file",
        "findings-file",
    ):
        assert subject in body


def test_review_contract_defines_every_handoff_and_result() -> None:
    contract = _review_contract()

    for subject in (
        "not_started -> ready -> passed | changes_requested",
        "Run the Reviewer synchronously",
        "Do not sleep",
        "# Plan handoff",
        "# QA handoff",
        "# Recheck handoff",
        "# Findings",
        "nextAction=fail_generation",
        "review-status --phase plan",
        "Candidate complete: yes",
        "QA finding:",
        "Work Packages",
        "Must explain",
        "missingPaths",
        "reviewPolicy",
        "plan_only",
        "plan_and_qa",
        "## Plan amendment",
        "plan_amendment",
        "effectivePlan",
        "Only the Coordinator",
    ):
        assert subject in contract


def test_review_command_prints_complete_persisted_state() -> None:
    script = (SKILLS / "wiki_submit" / "wiki_submit.js").read_text()

    assert "console.log(JSON.stringify(result))" in script
    assert "console.log(JSON.stringify(result.review || result))" not in script
    assert (
        "--writing-plan-file is required for a plan or amendment review handoff"
        in script
    )
