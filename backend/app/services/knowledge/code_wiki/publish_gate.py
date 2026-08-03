# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Deciding whether a finished version may be published.

A version being a complete snapshot is guaranteed by construction — seeding puts every
page there — but not by the agent's honesty. An agent that writes four pages and
reports success produces a version holding four pages, and the projection would
faithfully delete the rest.

So the version is checked before the published pointer moves. What makes this workable
is that the thing being checked is a complete, inspectable, retained snapshot rather
than a knowledge base already half-rewritten: a rejected version stays in the store
with its verdict attached, and the published one is still whatever it was.

Removal is the substantive check. It is what makes agent-declared deletion safe to
allow at all: deletions are permitted, mass deletion is not.

It is measured against the *set of published paths the version no longer contains*,
not against the two page counts. Counting would miss the case that matters most: a
version holding the same number of pages under mostly different paths is a mass
deletion plus a mass insertion, every affected page loses its document id, and every
stored citation and index entry pointing at it breaks. The count says nothing changed.
"""

import logging
from dataclasses import dataclass, field
from typing import Optional, Sequence

from app.services.knowledge.code_wiki.mermaid_check import (
    check_mermaid_blocks,
    describe_warnings,
)
from app.services.knowledge.code_wiki.page_path import collation_key
from app.services.knowledge.code_wiki.projection_plan import PageSource

logger = logging.getLogger(__name__)

# Key under which the verdict is recorded on the generation.
PUBLISH_GATE_EXT_KEY = "publishGate"


@dataclass(frozen=True)
class PublishPolicy:
    """Limits a version must respect to be published."""

    # Share of the previously published pages that may disappear in one publish.
    # Deleting pages is legitimate; deleting most of them is a malfunction, and the
    # difference cannot be told apart by inspecting any single page.
    max_removed_share: float = 0.5
    # A published wiki always has at least an overview page. A version with none is
    # not an empty repository, it is a run that produced nothing.
    min_pages: int = 1
    # Mermaid problems are reported, never blocking: a diagram that will not render is
    # a local display fault, and holding a whole version for one is a poor trade.
    block_on_mermaid: bool = False


DEFAULT_POLICY = PublishPolicy()


@dataclass(frozen=True)
class GateVerdict:
    """Whether a version may be published, and what was noticed."""

    passed: bool
    reason: str = ""
    warnings: tuple[str, ...] = field(default=())

    def to_ext(self, checked_at: str) -> dict:
        """Render for storage on the generation.

        Recorded to explain *why* a version is not live. It never decides that —
        the published pointer alone does — because a second source of truth for
        "which version is published" is a second thing that can be wrong.
        """
        return {
            "result": "passed" if self.passed else "rejected",
            "reason": self.reason,
            "warnings": list(self.warnings),
            "checkedAt": checked_at,
        }


def evaluate_publish_gate(
    pages: Sequence[PageSource],
    *,
    published_paths: Sequence[str],
    policy: Optional[PublishPolicy] = None,
) -> GateVerdict:
    """Judge a finished version against the currently published one.

    Args:
        pages: Every page in the version being considered.
        published_paths: Paths currently published, empty when nothing has been.
            Paths rather than a count: publishing a same-sized version under
            different paths deletes every page it renamed, and a count cannot see it.
        policy: Limits to apply.

    Returns:
        The verdict. Warnings never cause a rejection on their own.
    """
    policy = policy or DEFAULT_POLICY
    diagram_warnings = _diagram_warnings(pages)
    warnings = _structure_warnings(pages) + diagram_warnings

    if len(pages) < policy.min_pages:
        return GateVerdict(
            passed=False,
            reason=(
                f"version has {len(pages)} pages, fewer than the minimum "
                f"{policy.min_pages}; the run produced nothing usable"
            ),
            warnings=warnings,
        )

    if published_paths:
        kept = {collation_key(page.path) for page in pages}
        removed = [path for path in published_paths if collation_key(path) not in kept]
        removed_share = len(removed) / len(published_paths)
        if removed_share > policy.max_removed_share:
            return GateVerdict(
                passed=False,
                reason=(
                    f"version removes {removed_share:.0%} of the published pages "
                    f"({len(removed)} of {len(published_paths)}), over the "
                    f"{policy.max_removed_share:.0%} limit"
                ),
                warnings=warnings,
            )

    # Only the diagram warnings, despite `warnings` carrying more: a policy named
    # for diagrams must not start rejecting versions over a missing section page.
    if diagram_warnings and policy.block_on_mermaid:
        return GateVerdict(
            passed=False,
            reason="diagram problems were found and the policy blocks on them",
            warnings=warnings,
        )

    return GateVerdict(passed=True, warnings=warnings)


def _sections_without_a_page(pages: Sequence[PageSource]) -> list[str]:
    """Sections that hold pages but have no page of their own.

    Reported, never blocking — the same trade as a broken diagram. The navigation is
    built from paths, so such a section renders as a group heading that cannot be
    opened: a little worse to read, and nowhere near worth discarding a version that
    is otherwise complete. Asking for section pages belongs in the instructions, not
    in a gate that throws away the run.
    """
    present = {collation_key(page.path) for page in pages}
    # Keyed the same way membership is tested. Collecting the raw string instead
    # would report one section twice when two pages spell its prefix differently.
    missing: dict[str, str] = {}
    for page in pages:
        if "/" not in page.path:
            continue
        section = page.path.rsplit("/", 1)[0]
        key = collation_key(section)
        if key not in present:
            missing.setdefault(key, section)
    return sorted(missing.values())


def _structure_warnings(pages: Sequence[PageSource]) -> tuple[str, ...]:
    """Navigation problems worth reporting but not worth refusing a version over."""
    return tuple(
        f"{section}: holds pages but has no page of its own"
        for section in _sections_without_a_page(pages)
    )


def _diagram_warnings(pages: Sequence[PageSource]) -> tuple[str, ...]:
    """Diagrams that will not render, which the agent can be asked to fix."""
    collected: list[str] = []
    for page in pages:
        mermaid_warnings = check_mermaid_blocks(page.content)
        if mermaid_warnings:
            collected.append(f"{page.path}: {describe_warnings(mermaid_warnings)}")
    return tuple(collected)
