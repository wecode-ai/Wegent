# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for the publish gate.

The gate is what makes agent-declared deletion safe to allow: it lets a version remove
pages while refusing one that removes most of them.

Removal is measured over paths, not counts, so the cases below pair a version with the
set of paths currently published rather than with a number.
"""

from app.services.knowledge.code_wiki.projection_plan import PageSource
from app.services.knowledge.code_wiki.publish_gate import (
    PublishPolicy,
    evaluate_publish_gate,
)


def _pages(count: int, content: str = "flowchart TD\n  A --> B") -> list[PageSource]:
    return [
        PageSource(path=f"page-{index}", title=f"Page {index}", content=content)
        for index in range(count)
    ]


def _published(count: int) -> list[str]:
    """The paths a previously published version left in the knowledge base."""
    return [f"page-{index}" for index in range(count)]


def test_a_version_of_similar_size_passes():
    verdict = evaluate_publish_gate(_pages(10), published_paths=_published(10))

    assert verdict.passed


def test_a_first_publish_has_nothing_to_compare_against():
    verdict = evaluate_publish_gate(_pages(3), published_paths=_published(0))

    assert verdict.passed


def test_a_version_that_produced_nothing_is_rejected():
    """An empty repository still yields an overview page; zero means a failed run."""
    verdict = evaluate_publish_gate([], published_paths=_published(0))

    assert not verdict.passed
    assert "nothing usable" in verdict.reason


def test_dropping_most_of_the_wiki_is_rejected():
    verdict = evaluate_publish_gate(_pages(2), published_paths=_published(10))

    assert not verdict.passed
    assert "80%" in verdict.reason


def test_a_moderate_removal_is_allowed():
    """Deleting pages is legitimate; this is what the gate deliberately permits."""
    verdict = evaluate_publish_gate(_pages(7), published_paths=_published(10))

    assert verdict.passed


def test_the_removal_limit_is_configurable():
    strict = PublishPolicy(max_removed_share=0.1)

    verdict = evaluate_publish_gate(
        _pages(8), published_paths=_published(10), policy=strict
    )

    assert not verdict.passed


def test_growth_is_never_treated_as_removal():
    verdict = evaluate_publish_gate(_pages(50), published_paths=_published(2))

    assert verdict.passed


def test_a_broken_diagram_is_reported_but_does_not_block():
    """A diagram that will not render is a local display fault, not a bad version."""
    pages = [
        PageSource(path="index", title="Index", content="```mermaid\nflowchat TD\n```")
    ]

    verdict = evaluate_publish_gate(pages, published_paths=["index"])

    assert verdict.passed
    assert len(verdict.warnings) == 1
    assert "index:" in verdict.warnings[0]


def test_diagrams_can_be_made_blocking_by_policy():
    pages = [
        PageSource(path="index", title="Index", content="```mermaid\nflowchat TD\n```")
    ]

    verdict = evaluate_publish_gate(
        pages, published_paths=["index"], policy=PublishPolicy(block_on_mermaid=True)
    )

    assert not verdict.passed


def test_a_rejection_still_carries_its_warnings():
    """The verdict is stored to explain the rejection, so it must be complete."""
    pages = [
        PageSource(path="index", title="Index", content="```mermaid\nflowchat TD\n```")
    ]

    verdict = evaluate_publish_gate(pages, published_paths=_published(10))

    assert not verdict.passed
    assert verdict.warnings


def test_the_verdict_renders_for_storage():
    verdict = evaluate_publish_gate(_pages(1), published_paths=_published(10))

    stored = verdict.to_ext("2026-07-31T00:00:00")

    assert stored["result"] == "rejected"
    assert stored["reason"]
    assert stored["checkedAt"] == "2026-07-31T00:00:00"


def test_a_passing_verdict_renders_as_passed():
    stored = evaluate_publish_gate(_pages(5), published_paths=_published(5)).to_ext(
        "now"
    )

    assert stored["result"] == "passed"


# --- removal is about paths, not counts -------------------------------------


def test_replacing_every_path_is_a_mass_deletion_even_at_the_same_size():
    """The case counting cannot see. Ten pages become ten pages, and every one of
    them is a new document: the old ids are deleted, and every stored citation and
    index entry pointing at them breaks."""
    renamed = [
        PageSource(path=f"guide/page-{index}", title=f"Page {index}", content="body")
        for index in range(10)
    ]

    verdict = evaluate_publish_gate(renamed, published_paths=_published(10))

    assert not verdict.passed
    assert "100%" in verdict.reason


def test_renaming_a_few_paths_is_still_allowed():
    """Moving a page is legitimate; the gate only refuses moving most of them."""
    moved = [
        PageSource(path="guide/page-0", title="Page 0", content="body"),
        *_pages(10)[1:],
    ]

    verdict = evaluate_publish_gate(moved, published_paths=_published(10))

    assert verdict.passed


def test_a_path_kept_under_a_different_case_is_not_a_removal():
    """The knowledge tables collate case-insensitively, so the two are one page."""
    recased = [
        PageSource(path=f"Page-{index}", title=f"Page {index}", content="body")
        for index in range(10)
    ]

    verdict = evaluate_publish_gate(recased, published_paths=_published(10))

    assert verdict.passed


# --- sections that hold pages but are not pages ------------------------------


def test_a_section_with_no_page_of_its_own_is_reported_not_refused():
    """The navigation is built from paths, so it renders as a group heading that
    cannot be opened — worse to read, nowhere near worth discarding a version."""
    pages = [
        PageSource(path="index", title="Index", content="body"),
        PageSource(path="architecture/backend", title="Backend", content="body"),
    ]

    verdict = evaluate_publish_gate(pages, published_paths=[])

    assert verdict.passed
    assert any("architecture" in warning for warning in verdict.warnings)


def test_a_section_that_is_itself_a_page_draws_no_warning():
    pages = [
        PageSource(path="architecture", title="Architecture", content="body"),
        PageSource(path="architecture/backend", title="Backend", content="body"),
    ]

    verdict = evaluate_publish_gate(pages, published_paths=[])

    assert verdict.warnings == ()


def test_the_diagram_policy_does_not_reject_over_a_missing_section_page():
    """`block_on_mermaid` is named for diagrams; letting it fire on a navigation nit
    would make its name a lie and throw away versions nobody meant to refuse."""
    pages = [
        PageSource(path="index", title="Index", content="body"),
        PageSource(path="architecture/backend", title="Backend", content="body"),
    ]

    verdict = evaluate_publish_gate(
        pages, published_paths=[], policy=PublishPolicy(block_on_mermaid=True)
    )

    assert verdict.passed
    assert verdict.warnings
