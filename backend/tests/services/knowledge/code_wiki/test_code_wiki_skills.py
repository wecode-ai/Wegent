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


def test_wiki_submit_owns_the_page_write_contract():
    metadata, body = _skill("wiki_submit")

    assert metadata["bindShells"] == ["ClaudeCode"]
    for subject in (
        "at most 4 folders",
        "complete content",
        "section that holds pages needs a page",
        "[Backend](architecture/backend)",
        "--structure-order",
        "version was published",
        "Mermaid diagrams that do not render",
        "`complete` again",
    ):
        assert subject in body
