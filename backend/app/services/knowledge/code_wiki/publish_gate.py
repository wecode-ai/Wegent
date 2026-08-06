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

**The gate is advisory now.** One rule still refuses: a version holding no pages at
all, which is a run that produced nothing rather than an empty repository. Everything
else is measured, recorded on the version and shown in the run history, and published.

It did refuse large losses, and the reasoning was sound in the abstract: an agent that
writes four pages and reports success produces a version holding four, and the
projection would faithfully delete the rest. In practice it blocked three consecutive
runs — at one page, then fifteen, then nine, against twenty published — while the wiki
never updated once, and each shape it rejected turned out to be the agent restructuring
rather than failing. A wiki that cannot be regenerated is not being protected, and the
instability those numbers describe is the agent's to fix, not the gate's to hide.

What is lost with it: a genuinely truncated run now publishes, and the pages it did not
write are deleted from the knowledge base along with their document ids, so anything
citing them breaks. The version store keeps the previous version, so the content is
recoverable; the ids are not.

**How loss is measured still depends on how the version was made**, because the two
warnings mean different things.

An *incremental* version is seeded with every published page before the agent starts,
so it cannot be a truncated run: a path that is gone was dropped by an explicit
instruction. That is intent, not malfunction, and refusing it meant a deliberate
restructure could not be published at all. Large removals are reported and allowed.
The measure is still the set of missing paths rather than the two counts, because a
version holding the same number of pages under different paths is a mass deletion
plus a mass insertion — every affected page loses its document id, and every stored
citation and index entry pointing at it breaks — and a count cannot see that.

A *full rebuild* starts from nothing and re-derives the structure, so the paths it
lands on carry no intent: reorganising a wiki renames most of them, and reorganising
is what rebuilding is for. Measured by overlap, a rebuild that wrote fifteen good
pages under a new layout was refused for "removing 95% of the published pages" — and
no rebuild that renamed anything could ever have passed. What still separates a
reorganised wiki from a run that died halfway is how much of it came back, so a
rebuild is measured by size.
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

    # Share of the published pages an incremental run may drop before it is worth
    # saying so. Reported, not refused: an incremental version is seeded with every
    # published page before the agent starts, so a path that is gone was removed by
    # an explicit instruction. There is no truncated-run case to catch here, and
    # refusing meant a deliberate restructure could not be published at all.
    warn_removed_share: float = 0.5
    # How much smaller a rebuild may be than what it replaces before it is worth
    # saying so. Reported, not refused. Refusing was the honest reading -- a rebuild
    # starts empty, so a run that stopped early genuinely comes back short -- but in
    # practice it blocked three consecutive runs while the wiki never updated once,
    # and the shape it was rejecting kept turning out to be the agent restructuring
    # rather than failing. A wiki that cannot be regenerated is not being protected.
    warn_shrink_share: float = 0.5
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
    rebuilt: bool = False,
    policy: Optional[PublishPolicy] = None,
) -> GateVerdict:
    """Judge a finished version against the currently published one.

    Args:
        pages: Every page in the version being considered.
        published_paths: Paths currently published, empty when nothing has been.
        rebuilt: Whether this version was produced by a full rebuild. It decides
            which measure applies, and the two are not interchangeable. An
            incremental version starts as a copy of the published one, so a path that
            is gone was deliberately dropped and overlap is the honest measure. A
            rebuilt version starts empty and re-derives the structure, so overlap
            only counts renames -- and renaming is what rebuilding does.
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

    if published_paths and rebuilt:
        # Measured by size, not by overlap: a rebuild renames most paths by design,
        # so overlap would only count the renaming.
        shrink_share = 1 - (len(pages) / len(published_paths))
        if shrink_share > policy.warn_shrink_share:
            warnings = warnings + (
                f"rebuild came back with {len(pages)} pages where "
                f"{len(published_paths)} were published, {shrink_share:.0%} smaller",
            )

    if published_paths and not rebuilt:
        kept = {collation_key(page.path) for page in pages}
        removed = [path for path in published_paths if collation_key(path) not in kept]
        removed_share = len(removed) / len(published_paths)
        if removed_share > policy.warn_removed_share:
            warnings = warnings + (
                f"version removes {removed_share:.0%} of the published pages "
                f"({len(removed)} of {len(published_paths)})",
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
