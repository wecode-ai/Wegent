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
        _write_page(test_db, started.generation, f"page-{index}", "body")
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
