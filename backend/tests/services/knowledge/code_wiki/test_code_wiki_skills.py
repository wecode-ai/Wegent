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


def test_wiki_submit_owns_the_page_write_contract() -> None:
    metadata, body = _skill("wiki_submit")

    assert metadata["bindShells"] == ["ClaudeCode"]
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
    ):
        assert subject in body
