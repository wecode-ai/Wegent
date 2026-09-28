# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Regression coverage for Skill MCP names at the model API boundary."""

from shared.utils import mcp_names
from shared.utils.mcp_names import SkillMcpNames, resolve_skill_mcp_name


def test_interactive_form_tool_name_fits_model_limit() -> None:
    identity = ("prompts-to-movie-stepped", "wegent-interactive-form-question")
    compact_name = resolve_skill_mcp_name(*identity)

    assert len(f"mcp__{compact_name}__interactive_form_question") == 64
    skill_code, server_name = compact_name.split("_", 1)
    assert len(skill_code) == 7
    assert len(server_name) == 24
    assert resolve_skill_mcp_name(*identity) == compact_name


def test_names_differ_when_only_truncated_parts_differ() -> None:
    prefix = "prompts-to-movie-stepped"
    identities = [
        (prefix, "wegent-interactive-form-question"),
        (prefix, "wegent-interactive-form-question-v2"),
        (prefix + "-v2", "wegent-interactive-form-question"),
    ]

    compact_names = {resolve_skill_mcp_name(*identity) for identity in identities}

    assert len(compact_names) == len(identities)
    assert all(len(name) <= 32 for name in compact_names)


def test_skill_code_is_shared_across_servers_and_preserves_short_server_names() -> None:
    docs = resolve_skill_mcp_name("demo-skill", "docs")
    boundary = resolve_skill_mcp_name("demo-skill", "s" * 24)

    assert docs == "92d551f_docs"
    assert boundary == docs[:8] + "s" * 24
    assert len(resolve_skill_mcp_name("demo-skill", "s" * 25)) == 32


def test_provider_skill_keeps_its_unprefixed_name() -> None:
    assert resolve_skill_mcp_name("wegent-knowledge", "wegent-knowledge") == (
        "wegent-knowledge"
    )


def test_collision_is_resolved_without_overwriting_existing_identity(
    monkeypatch,
    caplog,
) -> None:
    short_code = mcp_names._short_code
    monkeypatch.setattr(
        mcp_names,
        "_short_code",
        lambda name: short_code(name) if "\0" in name else "abcdefg",
    )
    names = SkillMcpNames()
    first = names.register("skill-one", "docs")
    second = names.register("skill-two", "docs")

    assert second != first
    assert len(second.split("_", 1)[0]) == 7
    assert second.endswith("_docs")
    assert names.register("skill-one", "docs") == first
    assert names.register("skill-two", "docs") == second
    assert len(caplog.records) == 1
    assert caplog.records[0].levelname == "WARNING"
    assert "Skill MCP name collision" in caplog.text


def test_truncated_server_collision_is_resolved_within_name_budget(monkeypatch) -> None:
    short_code = mcp_names._short_code
    monkeypatch.setattr(
        mcp_names,
        "_short_code",
        lambda name: short_code(name) if "\0" in name else "abcdefg",
    )
    names = SkillMcpNames()
    first = names.register("skill", "shared-server-prefix-" + "a" * 20)
    second = names.register("skill", "shared-server-prefix-" + "b" * 20)

    assert first != second
    assert len(f"mcp__{second}__interactive_form_question") == 64


def test_rehash_continues_when_first_alternative_also_collides(monkeypatch) -> None:
    short_code = mcp_names._short_code
    monkeypatch.setattr(
        mcp_names,
        "_short_code",
        lambda name: short_code(name) if name.endswith("\0" + "2") else "abcdefg",
    )
    names = SkillMcpNames()
    first = names.register("skill-one", "docs")
    second = names.register("skill-two", "docs")

    assert second != first
    assert second == resolve_skill_mcp_name("skill-two", "docs", attempt=2)
