# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for the publish gate.

The gate is advisory. One rule still refuses — a version holding no pages, which is a
run that produced nothing rather than an empty repository — and everything else is
measured, warned about and published.

The two measures below say different things and are kept apart on purpose. A rebuild
is judged on how much came back, because its version starts empty and its paths carry
no intent. An incremental version is seeded with every published page, so it is judged
on which of them it dropped: a count would miss a version that renamed all of them,
which deletes every document id and breaks every citation pointing at one.
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


def test_dropping_most_of_the_wiki_is_reported_by_either_measure():
    """Both are warnings. Refusing a rebuild was the honest reading — its version
    starts empty, so a run that stopped early genuinely comes back short — but it
    blocked three consecutive runs while the wiki never updated once, and each shape
    it rejected turned out to be restructuring rather than failure.

    The two still say different things: a rebuild that shrank, an incremental run
    that dropped paths.
    """
    rebuilt = evaluate_publish_gate(
        _pages(2), published_paths=_published(10), rebuilt=True
    )
    incremental = evaluate_publish_gate(_pages(2), published_paths=_published(10))

    assert rebuilt.passed
    assert any("80% smaller" in warning for warning in rebuilt.warnings)
    assert incremental.passed
    assert any("removes 80%" in warning for warning in incremental.warnings)


def test_a_moderate_removal_is_allowed():
    """Deleting pages is legitimate; this is what the gate deliberately permits."""
    verdict = evaluate_publish_gate(_pages(7), published_paths=_published(10))

    assert verdict.passed


def test_the_shrink_warning_threshold_is_configurable():
    quiet = PublishPolicy(warn_shrink_share=0.9)

    verdict = evaluate_publish_gate(
        _pages(2), published_paths=_published(10), rebuilt=True, policy=quiet
    )

    assert verdict.passed
    assert not any("smaller" in warning for warning in verdict.warnings)


def test_the_removal_warning_threshold_is_configurable():
    quiet = PublishPolicy(warn_removed_share=0.9)

    verdict = evaluate_publish_gate(
        _pages(2), published_paths=_published(10), policy=quiet
    )

    assert verdict.passed
    assert not any("removes" in warning for warning in verdict.warnings)


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


def test_diagram_findings_are_kept_apart_from_the_rest():
    """The two go to different places. Diagram findings are sent back to the agent,
    which wrote the diagram and can still rewrite the page; a section with no page of
    its own describes the shape of the wiki and is for the run history. Separating
    them by matching on warning text would make that routing depend on wording.
    """
    pages = [
        PageSource(path="index", title="Index", content="```mermaid\nflowchat TD\n```"),
        PageSource(path="architecture/backend", title="Backend", content="body"),
    ]

    verdict = evaluate_publish_gate(pages, published_paths=[])

    assert len(verdict.warnings) == 2
    assert verdict.diagram_warnings == (verdict.warnings[1],)
    assert "index:" in verdict.diagram_warnings[0]


def test_a_verdict_with_nothing_wrong_carries_no_diagram_findings():
    verdict = evaluate_publish_gate(_pages(3), published_paths=_published(3))

    assert verdict.diagram_warnings == ()


def test_diagrams_can_be_made_blocking_by_policy():
    pages = [
        PageSource(path="index", title="Index", content="```mermaid\nflowchat TD\n```")
    ]

    verdict = evaluate_publish_gate(
        pages, published_paths=["index"], policy=PublishPolicy(block_on_mermaid=True)
    )

    assert not verdict.passed


def test_a_rejection_still_carries_its_warnings():
    """The verdict is stored to explain the rejection, so it must be complete.

    A minimum above one is the only way to provoke a refusal that still has warnings
    to carry: the empty version that normally trips it has no pages to warn about.
    """
    pages = [
        PageSource(path="index", title="Index", content="```mermaid\nflowchat TD\n```")
    ]

    verdict = evaluate_publish_gate(
        pages,
        published_paths=_published(10),
        rebuilt=True,
        policy=PublishPolicy(min_pages=2),
    )

    assert not verdict.passed
    assert verdict.warnings


def test_the_verdict_renders_for_storage():
    verdict = evaluate_publish_gate([], published_paths=_published(10), rebuilt=True)

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


def test_replacing_every_path_is_reported_though_the_size_is_unchanged():
    """The case counting cannot see. Ten pages become ten pages, and every one of
    them is a new document: the old ids are deleted, and every stored citation and
    index entry pointing at them breaks.

    Reported rather than refused. This used to be a rejection, on the reading that
    replacing everything is a malfunction — but an incremental version is seeded with
    every published page before the agent starts, so a path that is gone was dropped
    by an explicit instruction. Nothing here is an accident to be caught, and the
    rejection blocked deliberate restructuring outright.
    """
    renamed = [
        PageSource(path=f"guide/page-{index}", title=f"Page {index}", content="body")
        for index in range(10)
    ]

    verdict = evaluate_publish_gate(renamed, published_paths=_published(10))

    assert verdict.passed
    assert any("100%" in warning for warning in verdict.warnings), verdict.warnings


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


# --- how loss is measured depends on how the version was made ----------------


def _page(path: str):
    from app.services.knowledge.code_wiki.projection_plan import PageSource

    return PageSource(path=path, title=path, content="body")


def test_a_rebuild_that_reorganises_the_wiki_is_allowed():
    """The bug this split exists for.

    A run wrote fifteen good pages under a new structure. Measured by path overlap
    only one of the twenty published paths survived, so it was refused for "removing
    95% of the published pages" — and no rebuild that renamed anything could ever
    have been published, which is what rebuilding is for.
    """
    from app.services.knowledge.code_wiki.publish_gate import evaluate_publish_gate

    verdict = evaluate_publish_gate(
        [_page(f"new-{index}") for index in range(15)],
        published_paths=[f"old/{index}" for index in range(20)],
        rebuilt=True,
    )

    assert verdict.passed, verdict.reason


def test_a_rebuild_that_came_back_almost_empty_is_reported_and_published():
    """This used to be refused, and the refusal is what a wiki that never updated
    was paying for. An agent that wrote one page against twenty now publishes it and
    the warning says so — recoverable from the version store, which keeps the one it
    replaced, though the document ids of the deleted pages are not recoverable.
    """
    from app.services.knowledge.code_wiki.publish_gate import evaluate_publish_gate

    verdict = evaluate_publish_gate(
        [_page("index")],
        published_paths=[f"old/{index}" for index in range(20)],
        rebuilt=True,
    )

    assert verdict.passed
    assert any("came back with" in warning for warning in verdict.warnings)


def test_a_version_holding_nothing_is_the_one_thing_still_refused():
    """Not an empty repository — a run that produced nothing. Publishing it would
    delete every page the wiki has.
    """
    from app.services.knowledge.code_wiki.publish_gate import evaluate_publish_gate

    verdict = evaluate_publish_gate(
        [], published_paths=[f"old/{index}" for index in range(20)], rebuilt=True
    )

    assert not verdict.passed
    assert "produced nothing usable" in verdict.reason


def test_a_large_incremental_removal_is_reported_and_allowed():
    """An incremental version is seeded with every published page before the agent
    starts, so it cannot be a truncated run: a path that is gone was dropped by an
    explicit instruction. Refusing that blocked a deliberate restructure outright,
    while catching no failure that could actually happen.
    """
    from app.services.knowledge.code_wiki.publish_gate import evaluate_publish_gate

    verdict = evaluate_publish_gate(
        [_page(f"renamed-{index}") for index in range(20)],
        published_paths=[f"old/{index}" for index in range(20)],
        rebuilt=False,
    )

    assert verdict.passed
    assert any(
        "removes 100%" in warning for warning in verdict.warnings
    ), verdict.warnings


def test_an_incremental_run_that_kept_everything_says_nothing():
    from app.services.knowledge.code_wiki.publish_gate import evaluate_publish_gate

    paths = [f"old/{index}" for index in range(20)]
    verdict = evaluate_publish_gate(
        [_page(path) for path in paths], published_paths=paths, rebuilt=False
    )

    assert verdict.passed
    assert not any("removes" in warning for warning in verdict.warnings)
