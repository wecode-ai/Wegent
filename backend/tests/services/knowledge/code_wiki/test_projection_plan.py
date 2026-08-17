# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for the projection plan.

The plan decides what publishing a version does to the knowledge base, including what
it deletes, so these tests are mostly about it not reaching further than it should.
"""

from app.services.knowledge.code_wiki.projection_plan import (
    PageSource,
    ProjectedPage,
    compute_projection_plan,
    content_fingerprint,
)


def _source(path: str, content: str = "body") -> PageSource:
    return PageSource(path=path, title=path.rsplit("/", 1)[-1], content=content)


def _projected(
    document_id: int, path: str, content: str = "body", title: str | None = None
) -> ProjectedPage:
    return ProjectedPage(
        document_id=document_id,
        path=path,
        content_hash=content_fingerprint(title or path.rsplit("/", 1)[-1], content),
    )


def test_a_page_only_the_version_has_is_added():
    plan = compute_projection_plan([_source("index")], [])

    assert [page.path for page in plan.adds] == ["index"]
    assert plan.updates == ()
    assert plan.deletes == ()


def test_a_page_whose_content_changed_is_updated():
    plan = compute_projection_plan(
        [_source("index", "new")], [_projected(1, "index", "old")]
    )

    assert [update.existing.document_id for update in plan.updates] == [1]
    assert plan.adds == ()


def test_an_unchanged_page_is_skipped_entirely():
    """Where an incremental run's savings come from: no write, no reindex, no row."""
    plan = compute_projection_plan(
        [_source("index", "same")], [_projected(1, "index", "same")]
    )

    assert plan.skips == ("index",)
    assert plan.adds == ()
    assert plan.updates == ()
    assert plan.deletes == ()
    assert plan.is_empty


def test_a_page_only_the_knowledge_base_has_is_deleted():
    plan = compute_projection_plan([], [_projected(7, "modules/legacy")])

    assert [page.document_id for page in plan.deletes] == [7]


def test_a_moved_page_is_an_add_and_a_delete():
    """Identity is the path, so a move is not an in-place rename."""
    plan = compute_projection_plan(
        [_source("services/backend")], [_projected(3, "architecture/backend")]
    )

    assert [page.path for page in plan.adds] == ["services/backend"]
    assert [page.document_id for page in plan.deletes] == [3]


def test_matching_ignores_case_because_the_database_does():
    plan = compute_projection_plan(
        [_source("Architecture/Backend", "same")],
        # Same title on both sides: this is about the path matching, and letting the
        # helper derive two differently-cased titles would test something else.
        [_projected(1, "architecture/backend", "same", title="Backend")],
    )

    assert plan.skips == ("Architecture/Backend",)
    assert plan.deletes == ()


def test_a_rewritten_title_alone_still_updates_the_page():
    """The title is what the document is named, so a reworded heading has to reach
    the knowledge base. It used to be discarded, and comparing content alone was
    right then; now that trade-off is inverted — the cost is rewriting an attachment
    whose bytes did not change, and a title almost always moves with its body."""
    existing = _projected(1, "index", "unchanged body", title="Index")
    renamed = PageSource(
        path="index", title="A Better Heading", content="unchanged body"
    )

    plan = compute_projection_plan([renamed], [existing])

    assert plan.skips == ()
    assert [update.source.title for update in plan.updates] == ["A Better Heading"]


def test_an_empty_version_removes_everything_it_owns():
    """Deliberate: the publish gate, not the plan, decides whether that is acceptable."""
    plan = compute_projection_plan(
        [], [_projected(1, "a"), _projected(2, "b"), _projected(3, "c")]
    )

    assert len(plan.deletes) == 3


def test_a_mixed_version_is_reported_in_full():
    plan = compute_projection_plan(
        [
            _source("index", "changed"),
            _source("architecture/backend", "same"),
            _source("modules/new"),
        ],
        [
            _projected(1, "index", "original"),
            _projected(2, "architecture/backend", "same"),
            _projected(3, "modules/gone"),
        ],
    )

    assert [page.path for page in plan.adds] == ["modules/new"]
    assert [update.existing.document_id for update in plan.updates] == [1]
    assert plan.skips == ("architecture/backend",)
    assert [page.document_id for page in plan.deletes] == [3]
    assert plan.touched_pages == 3
    assert plan.describe() == "1 added, 1 updated, 1 removed, 1 unchanged"


def test_an_identical_snapshot_produces_no_work():
    pages = [_projected(1, "index", "x"), _projected(2, "a/b", "y")]
    sources = [_source("index", "x"), _source("a/b", "y")]

    assert compute_projection_plan(sources, pages).is_empty


def test_the_fingerprint_distinguishes_content():
    assert content_fingerprint("T", "a") != content_fingerprint("T", "b")
    assert content_fingerprint("T", "a") == content_fingerprint("T", "a")
