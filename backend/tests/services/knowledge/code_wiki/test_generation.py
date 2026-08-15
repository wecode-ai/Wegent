# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for starting and finishing a code wiki run.

This is where the separate decisions meet, so these tests are about the combinations:
a run that must not start, a version that must be seeded before the agent sees it, and
a failure that must leave the published wiki exactly as it was.
"""

from dataclasses import dataclass, field
from datetime import datetime, timedelta

import pytest
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.knowledge import KnowledgeDocument
from app.models.user import User
from app.models.wiki import WikiContent, WikiGeneration, WikiGenerationStatus
from app.services.knowledge.code_wiki.generation import (
    GenerationInFlight,
    current_run_state,
    finish_generation,
    published_commit,
    start_generation,
)
from app.services.knowledge.code_wiki.projection import ProjectionSideEffects
from app.services.knowledge.code_wiki.publisher import published_generation_id
from app.services.knowledge.code_wiki.run_mode import ChangedPath, RunMode
from app.services.knowledge.code_wiki.version_store import (
    STALE_RUN_AFTER_HOURS,
    set_page_path,
)

HEAD = "aaaaaaa"
NEXT_HEAD = "bbbbbbb"
NOW = datetime(2026, 7, 31, 12, 0, 0)


@dataclass
class FakeEffects:
    written: list[str] = field(default_factory=list)
    next_id: int = 7000

    def build(self) -> ProjectionSideEffects:
        return ProjectionSideEffects(
            write_attachment=self._write,
            delete_attachment=lambda _: None,
            delete_rag_document=lambda _: None,
            enqueue_reindex=lambda _: None,
        )

    def _write(self, *, filename: str, content: str) -> int:
        self.next_id += 1
        self.written.append(filename)
        return self.next_id


@pytest.fixture
def effects() -> FakeEffects:
    return FakeEffects()


@pytest.fixture
def knowledge_base(test_db: Session, test_user: User) -> Kind:
    kind = Kind(
        kind="KnowledgeBase",
        name="kb-generation",
        namespace="default",
        user_id=test_user.id,
        json={"spec": {"name": "wiki", "kbType": "code_wiki"}},
        is_active=True,
    )
    test_db.add(kind)
    test_db.flush()
    return kind


def _write_page(test_db: Session, generation: WikiGeneration, path: str, body: str):
    entry = WikiContent(
        generation_id=generation.id,
        type="chapter",
        title=path,
        content=body,
        parent_id=0,
    )
    set_page_path(entry, path)
    test_db.add(entry)
    test_db.flush()


def _publish_a_first_wiki(test_db, knowledge_base, test_user, effects, *, pages=3):
    started = start_generation(
        test_db,
        knowledge_base=knowledge_base,
        user=test_user,
        head_commit=HEAD,
        now=NOW,
    )
    for index in range(pages):
        # The same page each time: a version that replaced every page would be
        # refused by the publish gate, which is a different rule than this one.
        _write_page(test_db, started.generation, "index", f"body {index}")
    finish_generation(
        test_db,
        knowledge_base=knowledge_base,
        generation=started.generation,
        user=test_user,
        effects=effects.build(),
        succeeded=True,
        now=NOW,
    )
    return started.generation


def test_a_first_run_rebuilds_everything(
    test_db: Session, knowledge_base: Kind, test_user: User
):
    started = start_generation(
        test_db,
        knowledge_base=knowledge_base,
        user=test_user,
        head_commit=HEAD,
        now=NOW,
    )

    assert started.started
    assert RunMode(started.decision.mode) is RunMode.FULL
    assert started.seeded_pages == 0


def test_an_unchanged_repository_starts_nothing(
    test_db: Session, knowledge_base: Kind, test_user: User, effects: FakeEffects
):
    _publish_a_first_wiki(test_db, knowledge_base, test_user, effects)

    started = start_generation(
        test_db,
        knowledge_base=knowledge_base,
        user=test_user,
        head_commit=HEAD,
        now=NOW,
    )

    assert not started.started
    assert RunMode(started.decision.mode) is RunMode.SKIP


def test_an_explicit_full_rebuild_starts_at_the_same_commit(
    test_db: Session, knowledge_base: Kind, test_user: User, effects: FakeEffects
):
    _publish_a_first_wiki(test_db, knowledge_base, test_user, effects)

    started = start_generation(
        test_db,
        knowledge_base=knowledge_base,
        user=test_user,
        head_commit=HEAD,
        force_full=True,
        now=NOW,
    )

    assert started.started
    assert RunMode(started.decision.mode) is RunMode.FULL
    assert started.seeded_pages == 0


def test_an_incremental_run_is_seeded_before_the_agent_sees_it(
    test_db: Session, knowledge_base: Kind, test_user: User, effects: FakeEffects
):
    """An unseeded incremental version would be projected as a mass deletion."""
    _publish_a_first_wiki(test_db, knowledge_base, test_user, effects, pages=3)

    started = start_generation(
        test_db,
        knowledge_base=knowledge_base,
        user=test_user,
        head_commit=NEXT_HEAD,
        changed_paths=[ChangedPath("src/one.py", "M")],
        now=NOW,
    )

    assert RunMode(started.decision.mode) is RunMode.INCREMENTAL
    assert started.seeded_pages == 3


def test_a_full_run_starts_from_an_empty_version(
    test_db: Session, knowledge_base: Kind, test_user: User, effects: FakeEffects
):
    _publish_a_first_wiki(test_db, knowledge_base, test_user, effects, pages=3)

    started = start_generation(
        test_db,
        knowledge_base=knowledge_base,
        user=test_user,
        head_commit=NEXT_HEAD,
        changed_paths=None,  # unknown diff forces a rebuild
        now=NOW,
    )

    assert RunMode(started.decision.mode) is RunMode.FULL
    assert started.seeded_pages == 0


def test_a_second_run_is_refused_while_one_is_live(
    test_db: Session, knowledge_base: Kind, test_user: User
):
    start_generation(
        test_db,
        knowledge_base=knowledge_base,
        user=test_user,
        head_commit=HEAD,
        now=NOW,
    )

    with pytest.raises(GenerationInFlight):
        start_generation(
            test_db,
            knowledge_base=knowledge_base,
            user=test_user,
            head_commit=NEXT_HEAD,
            now=NOW,
        )


def test_an_abandoned_run_does_not_block_the_wiki_forever(
    test_db: Session, knowledge_base: Kind, test_user: User
):
    """A crashed worker would otherwise make the wiki unregenerable."""
    stuck = start_generation(
        test_db,
        knowledge_base=knowledge_base,
        user=test_user,
        head_commit=HEAD,
        now=NOW,
    ).generation

    # Aged explicitly: the row's updated_at comes from the database default, so
    # leaving it alone would measure staleness against the wall clock and make this
    # test pass or fail depending on the day it runs.
    stuck.updated_at = NOW
    test_db.flush()

    later = NOW + timedelta(hours=STALE_RUN_AFTER_HOURS + 1)
    started = start_generation(
        test_db,
        knowledge_base=knowledge_base,
        user=test_user,
        head_commit=NEXT_HEAD,
        now=later,
    )

    assert started.started
    test_db.refresh(stuck)
    assert stuck.status == WikiGenerationStatus.FAILED


def test_a_successful_run_publishes_its_version(
    test_db: Session, knowledge_base: Kind, test_user: User, effects: FakeEffects
):
    started = start_generation(
        test_db,
        knowledge_base=knowledge_base,
        user=test_user,
        head_commit=HEAD,
        now=NOW,
    )
    _write_page(test_db, started.generation, "index", "overview")

    result = finish_generation(
        test_db,
        knowledge_base=knowledge_base,
        generation=started.generation,
        user=test_user,
        effects=effects.build(),
        succeeded=True,
        now=NOW,
    )

    assert result is not None and result.published
    assert published_generation_id(knowledge_base) == started.generation.id
    assert published_commit(test_db, knowledge_base) == HEAD


def test_a_failed_run_leaves_the_published_wiki_untouched(
    test_db: Session, knowledge_base: Kind, test_user: User, effects: FakeEffects
):
    first = _publish_a_first_wiki(test_db, knowledge_base, test_user, effects, pages=3)

    started = start_generation(
        test_db,
        knowledge_base=knowledge_base,
        user=test_user,
        head_commit=NEXT_HEAD,
        changed_paths=[ChangedPath("src/one.py", "M")],
        now=NOW,
    )
    result = finish_generation(
        test_db,
        knowledge_base=knowledge_base,
        generation=started.generation,
        user=test_user,
        effects=effects.build(),
        succeeded=False,
        error_message="model timed out",
        now=NOW,
    )

    assert result is None
    assert published_generation_id(knowledge_base) == first.id
    assert started.generation.status == WikiGenerationStatus.FAILED
    assert (
        test_db.query(KnowledgeDocument)
        .filter(KnowledgeDocument.kind_id == knowledge_base.id)
        .count()
        == 3
    )


def test_a_failure_leaves_the_work_to_be_redone_not_skipped(
    test_db: Session, knowledge_base: Kind, test_user: User, effects: FakeEffects
):
    """The published commit must not advance, or the next run skips the changes."""
    _publish_a_first_wiki(test_db, knowledge_base, test_user, effects, pages=3)

    started = start_generation(
        test_db,
        knowledge_base=knowledge_base,
        user=test_user,
        head_commit=NEXT_HEAD,
        changed_paths=[ChangedPath("src/one.py", "M")],
        now=NOW,
    )
    finish_generation(
        test_db,
        knowledge_base=knowledge_base,
        generation=started.generation,
        user=test_user,
        effects=effects.build(),
        succeeded=False,
        now=NOW,
    )

    assert published_commit(test_db, knowledge_base) == HEAD

    retry = start_generation(
        test_db,
        knowledge_base=knowledge_base,
        user=test_user,
        head_commit=NEXT_HEAD,
        changed_paths=[ChangedPath("src/one.py", "M")],
        now=NOW,
    )

    assert retry.started


def test_the_run_mode_reason_is_kept_for_troubleshooting(
    test_db: Session, knowledge_base: Kind, test_user: User
):
    started = start_generation(
        test_db,
        knowledge_base=knowledge_base,
        user=test_user,
        head_commit=HEAD,
        now=NOW,
    )

    assert started.generation.ext["runModeReason"]


def test_a_wiki_running_on_increments_forever_is_eventually_rebuilt(
    test_db: Session, knowledge_base: Kind, test_user: User, effects: FakeEffects
):
    """decide_run_mode has had this branch from the start and was never given the
    inputs, so it defaulted to "no drift yet" and the rebuild never came however
    long the wiki ran on increments."""
    from app.models.wiki import WikiGenerationType
    from app.services.knowledge.code_wiki.run_mode import DEFAULT_POLICY

    _publish_a_first_wiki(test_db, knowledge_base, test_user, effects)

    for index in range(DEFAULT_POLICY.max_incrementals_since_full + 1):
        done = WikiGeneration(
            project_id=0,
            kind_id=knowledge_base.id,
            user_id=test_user.id,
            task_id=0,
            team_id=0,
            generation_type=WikiGenerationType.INCREMENTAL,
            source_snapshot={"commit": f"c{index}"},
            status=WikiGenerationStatus.COMPLETED,
            completed_at=NOW + timedelta(minutes=index + 1),
        )
        test_db.add(done)
    test_db.flush()

    started = start_generation(
        test_db,
        knowledge_base=knowledge_base,
        user=test_user,
        head_commit=NEXT_HEAD,
        changed_paths=[ChangedPath("src/one.py", "M")],
        now=NOW + timedelta(days=1),
    )

    assert RunMode(started.decision.mode) is RunMode.FULL
    assert "incremental" in started.decision.reason.lower()


# --- what a reader is told about the run -----------------------------------


def test_a_failure_reaches_the_reader_with_its_reason(
    test_db: Session, knowledge_base: Kind, test_user: User, effects: FakeEffects
):
    """Crosses the seam on purpose: the failure is written by one function and read
    back by another, and they used to disagree about the key it lives under. Written
    "errorMessage", read "error_message" -- so every failed run reported an empty
    reason, at the one moment a reader needs one. Asserting the stored key would have
    passed either way; only going in one end and out the other catches it.
    """
    started = start_generation(
        test_db,
        knowledge_base=knowledge_base,
        user=test_user,
        head_commit=HEAD,
        changed_paths=None,
        now=NOW,
    )
    finish_generation(
        test_db,
        knowledge_base=knowledge_base,
        generation=started.generation,
        user=test_user,
        effects=effects.build(),
        succeeded=False,
        error_message="git clone failed: could not read Username",
        now=NOW,
    )

    state = current_run_state(test_db, knowledge_base, now=NOW)

    assert state.status == "failed"
    assert state.error_message == "git clone failed: could not read Username"
    assert state.generation_id == started.generation.id


def test_a_failure_with_nothing_to_say_reports_nothing(
    test_db: Session, knowledge_base: Kind, test_user: User, effects: FakeEffects
):
    """An absent reason must read as absent, not as the string "None"."""
    started = start_generation(
        test_db,
        knowledge_base=knowledge_base,
        user=test_user,
        head_commit=HEAD,
        changed_paths=None,
        now=NOW,
    )
    finish_generation(
        test_db,
        knowledge_base=knowledge_base,
        generation=started.generation,
        user=test_user,
        effects=effects.build(),
        succeeded=False,
        now=NOW,
    )

    assert current_run_state(test_db, knowledge_base, now=NOW).error_message == ""


def test_a_wiki_that_has_never_run_says_so(test_db: Session, knowledge_base: Kind):
    assert current_run_state(test_db, knowledge_base, now=NOW).status == "never"


def test_a_running_wiki_is_reported_as_busy(
    test_db: Session, knowledge_base: Kind, test_user: User
):
    started = start_generation(
        test_db,
        knowledge_base=knowledge_base,
        user=test_user,
        head_commit=HEAD,
        changed_paths=None,
        now=NOW,
    )

    state = current_run_state(test_db, knowledge_base, now=NOW)

    assert state.status == "running"
    assert state.generation_id == started.generation.id
    assert not state.is_stale


def test_a_run_whose_worker_went_quiet_is_reported_as_stale(
    test_db: Session, knowledge_base: Kind, test_user: User
):
    """Stale is reported separately from running because the reader may act on it:
    the next trigger reclaims the version, so the regenerate button must stay live.

    Measured from the row's own timestamp rather than from ``NOW``: staleness is the
    gap since the worker last touched the version, and that column is written by the
    database, not by the ``now`` this call is given.
    """
    started = start_generation(
        test_db,
        knowledge_base=knowledge_base,
        user=test_user,
        head_commit=HEAD,
        changed_paths=None,
        now=NOW,
    )

    touched = started.generation.updated_at or started.generation.created_at
    later = touched + timedelta(hours=STALE_RUN_AFTER_HOURS + 1)
    state = current_run_state(test_db, knowledge_base, now=later)

    assert state.status == "running"
    assert state.is_stale


@pytest.mark.parametrize(
    "stored,reported",
    [
        ("RUNNING", "running"),
        ("COMPLETED", "completed"),
        ("FAILED", "failed"),
        ("PENDING", "failed"),
        ("CANCELLED", "failed"),
    ],
)
def test_five_stored_states_are_reported_as_three(stored: str, reported: str):
    """PENDING and CANCELLED collapse into failed on purpose: neither produced a
    version, and a reader deciding whether to regenerate needs that, not which
    internal state stopped it. Pinned because the collapse is a decision, not an
    oversight -- and because the status endpoint and the history must not disagree
    about it, which is why they share this one function.
    """
    from app.services.knowledge.code_wiki.generation import reader_status

    assert reader_status(WikiGeneration(status=stored)) == reported


def test_a_reason_this_server_invented_is_named_not_just_written(
    test_db: Session, knowledge_base: Kind, test_user: User, effects: FakeEffects
):
    """English written here was being shown to readers beside translated UI, which
    reads as a bug. The code is what a client can translate; the text stays for
    reasons that came from outside and cannot be.
    """
    from app.services.knowledge.code_wiki.generation import FailureCode

    started = start_generation(
        test_db,
        knowledge_base=knowledge_base,
        user=test_user,
        head_commit=HEAD,
        changed_paths=None,
        now=NOW,
    )
    finish_generation(
        test_db,
        knowledge_base=knowledge_base,
        generation=started.generation,
        user=test_user,
        effects=effects.build(),
        succeeded=False,
        error_message="",
        failure_code=FailureCode.TASK_ENDED_WITHOUT_REPORT,
        now=NOW,
    )

    state = current_run_state(test_db, knowledge_base, now=NOW)

    assert state.status == "failed"
    assert state.failure_code == FailureCode.TASK_ENDED_WITHOUT_REPORT
    # No detail invented to go with it: there is none.
    assert state.error_message == ""


def test_a_reclaimed_run_says_why_rather_than_nothing(
    test_db: Session, knowledge_base: Kind, test_user: User
):
    """Reclaiming recorded no reason at all, so an abandoned run reported "failed"
    and nothing else -- the same as being told nothing.
    """
    from app.services.knowledge.code_wiki.generation import FailureCode
    from app.services.knowledge.code_wiki.version_store import (
        reclaim_stale_generations,
    )

    stuck = start_generation(
        test_db,
        knowledge_base=knowledge_base,
        user=test_user,
        head_commit=HEAD,
        now=NOW,
    ).generation
    stuck.updated_at = NOW
    test_db.flush()

    reclaim_stale_generations(
        test_db,
        kind_id=knowledge_base.id,
        now=NOW + timedelta(hours=STALE_RUN_AFTER_HOURS + 1),
    )

    state = current_run_state(
        test_db, knowledge_base, now=NOW + timedelta(hours=STALE_RUN_AFTER_HOURS + 1)
    )
    assert state.status == "failed"
    assert state.failure_code == FailureCode.WORKER_ABANDONED


def test_the_reclaim_code_matches_the_one_clients_translate():
    """version_store states the code itself rather than importing it: generation.py
    imports version_store, so reaching back would close the cycle. Nothing else ties
    the two spellings together, and a drift would silently stop the reason being
    translated -- which is exactly the failure this replaced.
    """
    from app.services.knowledge.code_wiki.generation import FailureCode
    from app.services.knowledge.code_wiki.version_store import WORKER_ABANDONED_CODE

    assert WORKER_ABANDONED_CODE == FailureCode.WORKER_ABANDONED


def test_publishing_collects_the_versions_behind_it(
    test_db: Session, knowledge_base: Kind, test_user: User, effects: FakeEffects
):
    """Retention had no caller. The policy was written and tested and nothing ever
    ran it, so a wiki regenerating on a schedule kept every page of every run it had
    ever made.

    Publishing is the moment a version stops being the one readers see, which is what
    makes the ones behind it collectable.
    """
    from app.services.knowledge.code_wiki.version_store import DEFAULT_KEEP_SUCCESSFUL

    published = []
    for index in range(DEFAULT_KEEP_SUCCESSFUL + 2):
        started = start_generation(
            test_db,
            knowledge_base=knowledge_base,
            user=test_user,
            head_commit=f"commit{index}",
            changed_paths=None,
            now=NOW + timedelta(minutes=index),
        )
        # The same page each time: a version that replaced every page would be
        # refused by the publish gate, which is a different rule than this one.
        _write_page(test_db, started.generation, "index", f"body {index}")
        finish_generation(
            test_db,
            knowledge_base=knowledge_base,
            generation=started.generation,
            user=test_user,
            effects=effects.build(),
            succeeded=True,
            now=NOW + timedelta(minutes=index),
        )
        published.append(started.generation.id)

    surviving = {
        row.id
        for row in test_db.query(WikiGeneration).filter(
            WikiGeneration.kind_id == knowledge_base.id
        )
    }

    assert len(surviving) <= DEFAULT_KEEP_SUCCESSFUL
    # The newest is the published one and is exempt however the counting falls.
    assert published[-1] in surviving
    # The pages of a collected version go with it, or the rows outlive their parent.
    assert (
        test_db.query(WikiContent)
        .filter(WikiContent.generation_id == published[0])
        .count()
        == 0
    )


def test_a_failure_to_tidy_does_not_fail_a_publish(
    monkeypatch, test_db: Session, knowledge_base: Kind, test_user: User, effects
):
    """Housekeeping must not report a successfully published wiki as broken."""
    from app.services.knowledge.code_wiki import generation as generation_module

    def explode(*args, **kwargs):
        raise RuntimeError("retention exploded")

    monkeypatch.setattr(generation_module, "apply_retention", explode)

    started = start_generation(
        test_db,
        knowledge_base=knowledge_base,
        user=test_user,
        head_commit=HEAD,
        changed_paths=None,
        now=NOW,
    )
    _write_page(test_db, started.generation, "index", "overview")
    result = finish_generation(
        test_db,
        knowledge_base=knowledge_base,
        generation=started.generation,
        user=test_user,
        effects=effects.build(),
        succeeded=True,
        now=NOW,
    )

    assert result is not None and result.published


def test_a_refused_publish_is_not_recorded_as_a_successful_run(
    test_db: Session, knowledge_base: Kind, test_user: User, effects: FakeEffects
):
    """The status is set to COMPLETED before publishing is attempted, because the
    gate refuses to consider a version that is not. A refused version then kept it:
    the run read as a success while the wiki was unchanged.

    Refusal is provoked by concluding a version that holds no pages, which is the
    only thing the gate still refuses -- shrinking and renaming are reported now.
    """
    from app.services.knowledge.code_wiki.generation import FailureCode

    _publish_a_first_wiki(test_db, knowledge_base, test_user, effects, pages=3)

    started = start_generation(
        test_db,
        knowledge_base=knowledge_base,
        user=test_user,
        head_commit=NEXT_HEAD,
        changed_paths=None,
        now=NOW,
    )
    result = finish_generation(
        test_db,
        knowledge_base=knowledge_base,
        generation=started.generation,
        user=test_user,
        effects=effects.build(),
        succeeded=True,
        now=NOW,
    )

    assert result is not None and not result.published
    state = current_run_state(test_db, knowledge_base, now=NOW)
    assert state.status == "failed"
    assert state.failure_code == FailureCode.PUBLISH_REFUSED
    # The gate's own words survive.
    assert "produced nothing usable" in state.error_message


def test_a_successful_retry_clears_publish_refusal_metadata(
    test_db: Session, knowledge_base: Kind, test_user: User, effects: FakeEffects
):
    """A repaired run must not remain visible as the last failed run."""
    from app.services.knowledge.code_wiki.generation import FailureCode, failure_code

    _publish_a_first_wiki(test_db, knowledge_base, test_user, effects, pages=3)
    started = start_generation(
        test_db,
        knowledge_base=knowledge_base,
        user=test_user,
        head_commit=NEXT_HEAD,
        changed_paths=None,
        now=NOW,
    )
    finish_generation(
        test_db,
        knowledge_base=knowledge_base,
        generation=started.generation,
        user=test_user,
        effects=effects.build(),
        succeeded=True,
        now=NOW,
    )
    assert failure_code(started.generation) == FailureCode.PUBLISH_REFUSED

    _write_page(test_db, started.generation, "index", "repaired")
    result = finish_generation(
        test_db,
        knowledge_base=knowledge_base,
        generation=started.generation,
        user=test_user,
        effects=effects.build(),
        succeeded=True,
        now=NOW,
    )

    assert result is not None and result.published
    assert failure_code(started.generation) == ""
    assert "errorMessage" not in started.generation.ext
