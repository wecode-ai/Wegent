# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from pathlib import Path


def test_conversation_to_prompt_skill_exists():
    skill_dir = (
        Path(__file__).resolve().parents[3]
        / "init_data"
        / "skills"
        / "conversation_to_prompt"
    )
    assert skill_dir.exists()
    assert (skill_dir / "SKILL.md").exists()
    assert (skill_dir / "__init__.py").exists()
    assert (skill_dir / "provider.py").exists()


def test_conversation_to_prompt_skill_contract_sections():
    skill_md_path = (
        Path(__file__).resolve().parents[3]
        / "init_data"
        / "skills"
        / "conversation_to_prompt"
        / "SKILL.md"
    )
    content = skill_md_path.read_text(encoding="utf-8")

    assert "## Input Contract" in content
    assert "## Output Contract" in content
    assert "## Multi-Stage Flow" in content
    assert "## Required Prompt Structure" in content
    assert "你是{助手身份}，负责{核心职责}。" in content
