# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for the code wiki version store.

The store exists so that a failed or half-finished run stays invisible, so most of
these tests are about what survives a run going wrong.
"""

from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy.orm import Session

from app.models.wiki import (
    WikiContent,
    WikiGeneration,
    WikiGenerationStatus,
    WikiGenerationType,
)
from app.services.knowledge.code_wiki.page_path import InvalidPagePath
from app.services.knowledge.code_wiki.version_store import (
    STALE_RUN_AFTER_HOURS,
    apply_retention,
    page_path_of,
    reclaim_stale_generations,
    remove_page,
    seed_from_published,
    set_page_path,
)

KIND_ID = 77
NOW = datetime(2026, 7, 31, 12, 0, 0)


def _generation(
    db: Session,
    *,
    status: WikiGenerationStatus = WikiGenerationStatus.COMPLETED,
    created_at: datetime = NOW,
    updated_at: datetime = NOW,
    kind_id: int = KIND_ID,
) -> WikiGeneration:
    generation = WikiGeneration(
        project_id=1,
        kind_id=kind_id,
        user_id=1,
        task_id=0,
        team_id=1,
        generation_type=WikiGenerationType.FULL,
        source_snapshot={},
        status=status,
        created_at=created_at,
        updated_at=updated_at,
        completed_at=created_at,
    )
    db.add(generation)
    db.flush()
    return generation


def _page(
    db: Session, generation: WikiGeneration, path: str, content: str = "body"
) -> WikiContent:
    entry = WikiContent(
        generation_id=generation.id,
        type="chapter",
        title=path.rsplit("/", 1)[-1],
        content=content,
        parent_id=0,
    )
    set_page_path(entry, path)
    db.add(entry)
    db.flush()
    return entry


def _paths(db: Session, generation_id: int) -> set[str]:
    return {
        page_path_of(entry)
        for entry in db.query(WikiContent)
        .filter(WikiContent.generation_id == generation_id)
        .all()
    }


# --- seeding ---------------------------------------------------------------


def test_seeding_copies_the_published_version_verbatim(test_db: Session):
    published = _generation(test_db)
    _page(test_db, published, "index", "overview")
    _page(test_db, published, "architecture/backend", "backend notes")
    target = _generation(test_db, status=WikiGenerationStatus.RUNNING)

    outcome = seed_from_published(
        test_db,
        target_generation_id=target.id,
        published_generation_id=published.id,
    )

    assert outcome.seeded
    assert outcome.copied_pages == 2
    assert _paths(test_db, target.id) == {"index", "architecture/backend"}


def test_seeded_content_is_byte_identical(test_db: Session):
    """The projection skips pages whose hash is unchanged, which relies on this."""
    published = _generation(test_db)
    _page(test_db, published, "index", "exact bytes")
    target = _generation(test_db, status=WikiGenerationStatus.RUNNING)

    seed_from_published(
        test_db,
        target_generation_id=target.id,
        published_generation_id=published.id,
    )

    copied = (
        test_db.query(WikiContent).filter(WikiContent.generation_id == target.id).one()
    )
    assert copied.content == "exact bytes"


def test_seeding_does_not_carry_over_parent_ids(test_db: Session):
    """They name rows in the source version; copying them would dangle."""
    published = _generation(test_db)
    parent = _page(test_db, published, "architecture")
    child = _page(test_db, published, "architecture/backend")
    child.parent_id = parent.id
    test_db.flush()
    target = _generation(test_db, status=WikiGenerationStatus.RUNNING)

    seed_from_published(
        test_db,
        target_generation_id=target.id,
        published_generation_id=published.id,
    )

    copied = (
        test_db.query(WikiContent).filter(WikiContent.generation_id == target.id).all()
    )
    assert {entry.parent_id for entry in copied} == {0}


def test_seeding_twice_does_not_double_the_version(test_db: Session):
    """A retried scheduling attempt must not duplicate every page."""
    published = _generation(test_db)
    _page(test_db, published, "index")
    target = _generation(test_db, status=WikiGenerationStatus.RUNNING)

    seed_from_published(
        test_db,
        target_generation_id=target.id,
        published_generation_id=published.id,
    )
    second = seed_from_published(
        test_db,
        target_generation_id=target.id,
        published_generation_id=published.id,
    )

    assert not second.seeded
    assert len(_paths(test_db, target.id)) == 1


def test_a_first_run_has_nothing_to_seed_from(test_db: Session):
    target = _generation(test_db, status=WikiGenerationStatus.RUNNING)

    outcome = seed_from_published(
        test_db, target_generation_id=target.id, published_generation_id=0
    )

    assert not outcome.seeded
    assert _paths(test_db, target.id) == set()


# --- agent-declared deletion ----------------------------------------------


def test_an_agent_can_drop_a_page_from_the_in_flight_version(test_db: Session):
    generation = _generation(test_db, status=WikiGenerationStatus.RUNNING)
    _page(test_db, generation, "index")
    _page(test_db, generation, "modules/legacy")

    assert remove_page(test_db, generation_id=generation.id, path="modules/legacy")

    assert _paths(test_db, generation.id) == {"index"}


def test_removing_a_page_leaves_the_published_version_untouched(test_db: Session):
    """Deletion is recoverable precisely because it lands in an unpublished version."""
    published = _generation(test_db)
    _page(test_db, published, "modules/legacy")
    draft = _generation(test_db, status=WikiGenerationStatus.RUNNING)
    _page(test_db, draft, "modules/legacy")

    remove_page(test_db, generation_id=draft.id, path="modules/legacy")

    assert _paths(test_db, published.id) == {"modules/legacy"}


def test_removing_matches_the_page_regardless_of_case(test_db: Session):
    generation = _generation(test_db, status=WikiGenerationStatus.RUNNING)
    _page(test_db, generation, "Modules/Legacy")

    assert remove_page(test_db, generation_id=generation.id, path="modules/legacy")


def test_removing_an_unknown_page_reports_that_nothing_happened(test_db: Session):
    generation = _generation(test_db, status=WikiGenerationStatus.RUNNING)
    _page(test_db, generation, "index")

    assert not remove_page(test_db, generation_id=generation.id, path="nope")


def test_removing_rejects_a_malformed_path(test_db: Session):
    generation = _generation(test_db, status=WikiGenerationStatus.RUNNING)

    with pytest.raises(InvalidPagePath):
        remove_page(test_db, generation_id=generation.id, path="../escape")


# --- stale run reclamation -------------------------------------------------


def test_an_abandoned_run_is_failed_so_the_wiki_is_not_blocked(test_db: Session):
    """A crashed worker would otherwise hold the wiki forever."""
    stuck = _generation(
        test_db,
        status=WikiGenerationStatus.RUNNING,
        updated_at=NOW - timedelta(hours=STALE_RUN_AFTER_HOURS + 1),
    )

    reclaimed = reclaim_stale_generations(test_db, kind_id=KIND_ID, now=NOW)

    assert reclaimed == (stuck.id,)
    assert stuck.status == WikiGenerationStatus.FAILED


def test_a_slow_but_live_run_is_left_alone(test_db: Session):
    _generation(
        test_db,
        status=WikiGenerationStatus.RUNNING,
        updated_at=NOW - timedelta(hours=STALE_RUN_AFTER_HOURS - 1),
    )

    assert reclaim_stale_generations(test_db, kind_id=KIND_ID, now=NOW) == ()


def test_reclamation_ignores_finished_runs(test_db: Session):
    _generation(
        test_db,
        status=WikiGenerationStatus.COMPLETED,
        updated_at=NOW - timedelta(days=30),
    )

    assert reclaim_stale_generations(test_db, kind_id=KIND_ID, now=NOW) == ()


def test_reclamation_is_scoped_to_one_knowledge_base(test_db: Session):
    _generation(
        test_db,
        kind_id=KIND_ID + 1,
        status=WikiGenerationStatus.RUNNING,
        updated_at=NOW - timedelta(days=5),
    )

    assert reclaim_stale_generations(test_db, kind_id=KIND_ID, now=NOW) == ()


# --- retention -------------------------------------------------------------


def test_retention_keeps_the_newest_successful_versions(test_db: Session):
    generations = [
        _generation(test_db, created_at=NOW - timedelta(days=index))
        for index in range(5)
    ]

    removed = apply_retention(
        test_db,
        kind_id=KIND_ID,
        published_generation_id=generations[0].id,
        keep_successful=3,
        now=NOW,
    )

    assert set(removed) == {generations[3].id, generations[4].id}


def test_retention_deletes_the_pages_of_a_collected_version(test_db: Session):
    old = _generation(test_db, created_at=NOW - timedelta(days=10))
    _page(test_db, old, "index")
    current = _generation(test_db, created_at=NOW)

    apply_retention(
        test_db,
        kind_id=KIND_ID,
        published_generation_id=current.id,
        keep_successful=1,
        now=NOW,
    )

    assert _paths(test_db, old.id) == set()


def test_the_published_version_survives_newer_versions_that_never_published(
    test_db: Session,
):
    """A rejected publish gate leaves a completed version that was never published.

    Enough of those push the published one out of the newest ``keep_successful``,
    which would collect the only version there is to roll back to. Note that runs
    which *fail* cannot cause this — they never enter the successful list at all.
    """
    published = _generation(test_db, created_at=NOW - timedelta(days=9))
    for index in range(5):
        _generation(test_db, created_at=NOW - timedelta(days=index))

    removed = apply_retention(
        test_db,
        kind_id=KIND_ID,
        published_generation_id=published.id,
        keep_successful=3,
        now=NOW,
    )

    assert published.id not in removed
    assert test_db.get(WikiGeneration, published.id) is not None


def test_the_published_version_survives_a_repository_that_never_changes(
    test_db: Session,
):
    """With no new commits there are no new versions, so every version ages out."""
    published = _generation(test_db, created_at=NOW - timedelta(days=400))

    removed = apply_retention(
        test_db,
        kind_id=KIND_ID,
        published_generation_id=published.id,
        max_age_days=90,
        now=NOW,
    )

    assert removed == ()
    assert test_db.get(WikiGeneration, published.id) is not None


def test_retention_drops_versions_past_the_age_limit(test_db: Session):
    stale = _generation(test_db, created_at=NOW - timedelta(days=200))
    current = _generation(test_db, created_at=NOW)

    removed = apply_retention(
        test_db,
        kind_id=KIND_ID,
        published_generation_id=current.id,
        max_age_days=90,
        now=NOW,
    )

    assert removed == (stale.id,)


def test_failed_versions_are_kept_briefly_for_investigation(test_db: Session):
    recent = _generation(
        test_db,
        status=WikiGenerationStatus.FAILED,
        created_at=NOW - timedelta(days=2),
    )
    ancient = _generation(
        test_db,
        status=WikiGenerationStatus.FAILED,
        created_at=NOW - timedelta(days=30),
    )

    removed = apply_retention(
        test_db,
        kind_id=KIND_ID,
        published_generation_id=0,
        failed_retention_days=7,
        now=NOW,
    )

    assert removed == (ancient.id,)
    assert test_db.get(WikiGeneration, recent.id) is not None


def test_retention_never_collects_a_run_that_is_still_in_flight(test_db: Session):
    """Its pages are being written to; deleting them would corrupt a live run.

    Reclamation normally fails an abandoned run long before it reaches this age, but
    retention must not rely on that having happened.
    """
    for status in (WikiGenerationStatus.PENDING, WikiGenerationStatus.RUNNING):
        in_flight = _generation(
            test_db, status=status, created_at=NOW - timedelta(days=30)
        )

        removed = apply_retention(
            test_db,
            kind_id=KIND_ID,
            published_generation_id=0,
            failed_retention_days=7,
            now=NOW,
        )

        assert in_flight.id not in removed
        assert test_db.get(WikiGeneration, in_flight.id) is not None


def test_an_aware_reference_time_is_converted_rather_than_truncated(test_db: Session):
    """Dropping the offset instead of converting shifts the cutoff by that offset.

    The version sits just inside the retention window once the +14:00 reference is
    properly converted to UTC, and just outside it if the offset is merely discarded.
    Anything further from the boundary passes either way and would prove nothing.
    """
    _generation(
        test_db,
        status=WikiGenerationStatus.FAILED,
        created_at=NOW - timedelta(days=7, hours=6),
    )
    aware_now = NOW.replace(tzinfo=timezone(timedelta(hours=14)))

    removed = apply_retention(
        test_db,
        kind_id=KIND_ID,
        published_generation_id=0,
        failed_retention_days=7,
        now=aware_now,
    )

    assert removed == ()


def test_retention_is_scoped_to_one_knowledge_base(test_db: Session):
    other = _generation(
        test_db, kind_id=KIND_ID + 1, created_at=NOW - timedelta(days=999)
    )

    removed = apply_retention(
        test_db, kind_id=KIND_ID, published_generation_id=0, now=NOW
    )

    assert other.id not in removed
