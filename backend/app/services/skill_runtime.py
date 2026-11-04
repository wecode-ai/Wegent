# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Validate runtime compatibility before distributing selected Skill packages."""

import logging
from collections.abc import Iterable
from typing import Any

logger = logging.getLogger(__name__)


class SkillShellMismatchError(ValueError):
    """A selected Skill does not support the target execution runtime."""


def select_runtime_skill_names(
    bot: dict[str, Any],
    *,
    required_skills: Iterable[str] = (),
    execution_shell: str | None = None,
) -> list[str]:
    """Project optional defaults onto the runtime; required selections stay strict."""
    required = set(required_skills) | set(bot.get("preload_skills") or [])
    references = bot.get("skill_refs") or {}
    shells = {bot.get("shell_type"), execution_shell} - {None, ""}
    selected = []
    for name in bot.get("skills") or []:
        bindings = references.get(name, {}).get("bind_shells")
        incompatible = sorted(shells - set(bindings)) if bindings else []
        if incompatible:
            if name in required:
                raise SkillShellMismatchError(
                    f"Skill '{name}' is not compatible with Shell '{incompatible[0]}'"
                )
            logger.info(
                "Excluded optional Skill from execution: name=%s skill_id=%s shell=%s",
                name,
                references.get(name, {}).get("skill_id"),
                incompatible,
            )
            continue
        selected.append(name)
    return selected


def validate_skill_shells(
    bots: list[dict[str, Any]],
    skill_refs: dict[str, dict[str, Any]] | None = None,
) -> None:
    """Reject incompatible active selections; absent bindings remain unrestricted."""
    for bot in bots:
        shell = bot.get("shell_type")
        if not shell:
            continue
        references = {**(skill_refs or {}), **(bot.get("skill_refs") or {})}
        names = set(bot.get("skills") or []) | set(bot.get("preload_skills") or [])
        for name in names:
            shells = references.get(name, {}).get("bind_shells")
            if shells and shell not in shells:
                raise SkillShellMismatchError(
                    f"Skill '{name}' is not compatible with Shell '{shell}'"
                )
