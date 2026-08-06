# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for publishing a code wiki version.

Publishing is the only thing that moves the published pointer, and a rollback is the
same operation aimed at an older version, so these tests cover both through one path.
"""

from dataclasses import dataclass, field
from datetime import datetime

import pytest
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.knowledge import ContentOrigin, KnowledgeDocument
from app.models.wiki import (
    WikiContent,
    WikiGeneration,
    WikiGenerationStatus,
    WikiGenerationType,
)
from app.services.knowledge.code_wiki.projection import (
    PENDING_INDEX_CLEANUP_KEY,
    ProjectionSideEffects,
)
from app.services.knowledge.code_wiki.publish_gate import (
    PUBLISH_GATE_EXT_KEY,
    PublishPolicy,
)
from app.services.knowledge.code_wiki.publisher import (
    PAGE_ORDER_KEY,
    PUBLISHED_AT_KEY,
    PUBLISHED_COMMIT_KEY,
    PUBLISHED_GENERATION_KEY,
    publish_generation,
    published_generation_id,
    retry_pending_index_cleanup,
)
from app.services.knowledge.code_wiki.version_store import set_page_path

USER_ID = 11


@dataclass
class FakeEffects:
    written: list[str] = field(default_factory=list)
    deleted_attachments: list[int] = field(default_factory=list)
    deleted_rag: list[int] = field(default_factory=list)
    reindexed: list[int] = field(default_factory=list)
    failing_rag: set[int] = field(default_factory=set)
    next_id: int = 5000

    def build(self) -> ProjectionSideEffects:
        return ProjectionSideEffects(
            write_attachment=self._write,
            delete_attachment=self.deleted_attachments.append,
            delete_rag_document=self._delete_rag,
            enqueue_reindex=self.reindexed.append,
        )

    def _write(self, *, filename: str, content: str) -> int:
        self.next_id += 1
        self.written.append(filename)
        return self.next_id

    def _delete_rag(self, doc_ref: int) -> None:
        if doc_ref in self.failing_rag:
            raise RuntimeError("vector store down")
        self.deleted_rag.append(doc_ref)


@pytest.fixture
def effects() -> FakeEffects:
    return FakeEffects()


@pytest.fixture
def knowledge_base(test_db: Session) -> Kind:
    kind = Kind(
        kind="KnowledgeBase",
        name="kb-code-wiki",
        namespace="default",
        user_id=USER_ID,
        json={"spec": {"name": "wiki", "kbType": "code_wiki"}},
        is_active=True,
    )
    test_db.add(kind)
    test_db.flush()
    return kind


def _generation(
    test_db: Session,
    kind_id: int,
    *,
    status: WikiGenerationStatus = WikiGenerationStatus.COMPLETED,
) -> WikiGeneration:
    generation = WikiGeneration(
        project_id=1,
        kind_id=kind_id,
        user_id=USER_ID,
        task_id=0,
        team_id=1,
        generation_type=WikiGenerationType.FULL,
        source_snapshot={},
        status=status,
        completed_at=datetime(1970, 1, 1),
    )
    test_db.add(generation)
    test_db.flush()
    return generation


def _page(test_db: Session, generation: WikiGeneration, path: str, content: str):
    entry = WikiContent(
        generation_id=generation.id,
        type="chapter",
        title=path.rsplit("/", 1)[-1],
        content=content,
        parent_id=0,
    )
    set_page_path(entry, path)
    test_db.add(entry)
    test_db.flush()
    return entry


def _live_paths(test_db: Session, kind_id: int) -> set[str]:
    from app.services.knowledge.code_wiki.projection_plan import PAGE_PATH_KEY

    return {
        (document.source_config or {}).get(PAGE_PATH_KEY)
        for document in test_db.query(KnowledgeDocument)
        .filter(KnowledgeDocument.kind_id == kind_id)
        .all()
    }


def test_a_first_publish_creates_the_pages_and_moves_the_pointer(
    test_db: Session, knowledge_base: Kind, effects: FakeEffects
):
    generation = _generation(test_db, knowledge_base.id)
    _page(test_db, generation, "index", "overview")
    _page(test_db, generation, "architecture/backend", "details")

    result = publish_generation(
        test_db,
        knowledge_base=knowledge_base,
        generation=generation,
        user_id=USER_ID,
        effects=effects.build(),
    )

    assert result.published
    assert _live_paths(test_db, knowledge_base.id) == {"index", "architecture/backend"}
    assert published_generation_id(knowledge_base) == generation.id


def test_a_rejected_version_leaves_the_pointer_and_pages_alone(
    test_db: Session, knowledge_base: Kind, effects: FakeEffects
):
    """The published wiki must survive a run that produced almost nothing."""
    first = _generation(test_db, knowledge_base.id)
    for index in range(10):
        _page(test_db, first, f"page-{index}", "body")
    publish_generation(
        test_db,
        knowledge_base=knowledge_base,
        generation=first,
        user_id=USER_ID,
        effects=effects.build(),
    )

    # An empty version: the only thing the gate still refuses, now that shrinking
    # and renaming are reported rather than blocked.
    second = _generation(test_db, knowledge_base.id)

    result = publish_generation(
        test_db,
        knowledge_base=knowledge_base,
        generation=second,
        user_id=USER_ID,
        effects=effects.build(),
    )

    assert not result.published
    assert published_generation_id(knowledge_base) == first.id
    assert len(_live_paths(test_db, knowledge_base.id)) == 10


def test_a_rejection_is_recorded_on_the_generation(
    test_db: Session, knowledge_base: Kind, effects: FakeEffects
):
    """Explains why a finished version is not live; the pointer still decides."""
    generation = _generation(test_db, knowledge_base.id)

    publish_generation(
        test_db,
        knowledge_base=knowledge_base,
        generation=generation,
        user_id=USER_ID,
        effects=effects.build(),
    )

    recorded = (generation.ext or {})[PUBLISH_GATE_EXT_KEY]
    assert recorded["result"] == "rejected"
    assert recorded["reason"]


def test_an_unfinished_generation_is_not_published(
    test_db: Session, knowledge_base: Kind, effects: FakeEffects
):
    generation = _generation(
        test_db, knowledge_base.id, status=WikiGenerationStatus.RUNNING
    )
    _page(test_db, generation, "index", "body")

    result = publish_generation(
        test_db,
        knowledge_base=knowledge_base,
        generation=generation,
        user_id=USER_ID,
        effects=effects.build(),
    )

    assert not result.published
    assert published_generation_id(knowledge_base) == 0


def test_publishing_again_with_unchanged_content_does_nothing(
    test_db: Session, knowledge_base: Kind, effects: FakeEffects
):
    generation = _generation(test_db, knowledge_base.id)
    _page(test_db, generation, "index", "same")
    publish_generation(
        test_db,
        knowledge_base=knowledge_base,
        generation=generation,
        user_id=USER_ID,
        effects=effects.build(),
    )

    repeat = FakeEffects()
    result = publish_generation(
        test_db,
        knowledge_base=knowledge_base,
        generation=generation,
        user_id=USER_ID,
        effects=repeat.build(),
    )

    assert result.published
    assert repeat.written == []
    assert repeat.reindexed == []


def test_rolling_back_is_publishing_an_older_version(
    test_db: Session, knowledge_base: Kind, effects: FakeEffects
):
    """No separate machinery: the same call, aimed at the version you want back."""
    first = _generation(test_db, knowledge_base.id)
    _page(test_db, first, "index", "original")
    _page(test_db, first, "keep-me", "body")
    publish_generation(
        test_db,
        knowledge_base=knowledge_base,
        generation=first,
        user_id=USER_ID,
        effects=effects.build(),
    )

    second = _generation(test_db, knowledge_base.id)
    _page(test_db, second, "index", "rewritten")
    publish_generation(
        test_db,
        knowledge_base=knowledge_base,
        generation=second,
        user_id=USER_ID,
        effects=effects.build(),
        policy=PublishPolicy(warn_removed_share=1.0),
    )
    assert _live_paths(test_db, knowledge_base.id) == {"index"}

    result = publish_generation(
        test_db,
        knowledge_base=knowledge_base,
        generation=first,
        user_id=USER_ID,
        effects=effects.build(),
        require_completed=False,
    )

    assert result.published
    assert _live_paths(test_db, knowledge_base.id) == {"index", "keep-me"}
    assert published_generation_id(knowledge_base) == first.id


def test_user_content_survives_a_publish(
    test_db: Session, knowledge_base: Kind, effects: FakeEffects
):
    """It is not regenerable, so the projection must never see it."""
    note = KnowledgeDocument(
        kind_id=knowledge_base.id,
        attachment_id=1,
        name="my note",
        file_extension="md",
        file_size=4,
        user_id=USER_ID,
        folder_id=0,
        origin=ContentOrigin.USER.value,
    )
    test_db.add(note)
    test_db.flush()

    generation = _generation(test_db, knowledge_base.id)
    _page(test_db, generation, "index", "body")
    publish_generation(
        test_db,
        knowledge_base=knowledge_base,
        generation=generation,
        user_id=USER_ID,
        effects=effects.build(),
    )

    assert test_db.get(KnowledgeDocument, note.id) is not None


def test_a_failed_index_deletion_is_parked_for_retry(
    test_db: Session, knowledge_base: Kind, effects: FakeEffects
):
    """A row gone while its chunks remain leaves retrieval citing a dead page."""
    first = _generation(test_db, knowledge_base.id)
    _page(test_db, first, "index", "body")
    _page(test_db, first, "doomed", "body")
    publish_generation(
        test_db,
        knowledge_base=knowledge_base,
        generation=first,
        user_id=USER_ID,
        effects=effects.build(),
    )
    doomed_id = next(
        document.id
        for document in test_db.query(KnowledgeDocument).all()
        if document.name == "doomed"
    )

    second = _generation(test_db, knowledge_base.id)
    _page(test_db, second, "index", "body")
    broken = FakeEffects(failing_rag={doomed_id})

    result = publish_generation(
        test_db,
        knowledge_base=knowledge_base,
        generation=second,
        user_id=USER_ID,
        effects=broken.build(),
    )

    # Stated rather than assumed: this version removes exactly half the published
    # pages, which sits on the gate's threshold. Without this the test would still
    # fail if the gate ever tightened, but as a confusing KeyError below.
    assert result.published
    parked = (knowledge_base.json or {})["spec"][PENDING_INDEX_CLEANUP_KEY]
    assert parked == [str(doomed_id)]


def test_parked_cleanup_is_cleared_once_it_succeeds(
    test_db: Session, knowledge_base: Kind, effects: FakeEffects
):
    knowledge_base.json = {
        "spec": {
            "name": "wiki",
            "kbType": "code_wiki",
            PENDING_INDEX_CLEANUP_KEY: ["42"],
        }
    }
    test_db.flush()

    outstanding = retry_pending_index_cleanup(
        test_db, knowledge_base=knowledge_base, effects=effects.build()
    )

    assert outstanding == ()
    assert knowledge_base.json["spec"][PENDING_INDEX_CLEANUP_KEY] == []
    assert effects.deleted_rag == [42]


def test_cleanup_that_still_fails_stays_parked(test_db: Session, knowledge_base: Kind):
    knowledge_base.json = {"spec": {"name": "wiki", PENDING_INDEX_CLEANUP_KEY: ["42"]}}
    test_db.flush()
    broken = FakeEffects(failing_rag={42})

    outstanding = retry_pending_index_cleanup(
        test_db, knowledge_base=knowledge_base, effects=broken.build()
    )

    assert outstanding == ("42",)


def test_the_published_pointer_starts_at_nothing(knowledge_base: Kind):
    assert published_generation_id(knowledge_base) == 0
    assert PUBLISHED_GENERATION_KEY not in knowledge_base.json["spec"]


def test_a_publish_settles_what_the_last_one_could_not(
    test_db: Session, knowledge_base: Kind, effects: FakeEffects
):
    """There is no sweeper. Publishing is the only thing that drains the debt, which
    is what keeps this function the single writer of the parked list — two writers
    doing read-modify-write on one spec key eventually drop a ref."""
    knowledge_base.json = {
        "spec": {
            "name": "wiki",
            "kbType": "code_wiki",
            PENDING_INDEX_CLEANUP_KEY: ["4242"],
        }
    }
    test_db.flush()

    generation = _generation(test_db, knowledge_base.id)
    _page(test_db, generation, "index", "body")
    result = publish_generation(
        test_db,
        knowledge_base=knowledge_base,
        generation=generation,
        user_id=USER_ID,
        effects=effects.build(),
    )

    assert result.published
    assert 4242 in effects.deleted_rag
    assert (knowledge_base.json or {})["spec"][PENDING_INDEX_CLEANUP_KEY] == []


def test_a_rejected_publish_still_settles_the_old_debt(
    test_db: Session, knowledge_base: Kind, effects: FakeEffects
):
    """The debt has nothing to do with whether this version is publishable."""
    first = _generation(test_db, knowledge_base.id)
    for path in ("index", "one", "two", "three"):
        _page(test_db, first, path, "body")
    publish_generation(
        test_db,
        knowledge_base=knowledge_base,
        generation=first,
        user_id=USER_ID,
        effects=effects.build(),
    )
    _update_spec_pending(test_db, knowledge_base, ["4242"])

    # Empty, which is the only version the gate still refuses.
    collapsed = _generation(test_db, knowledge_base.id)
    result = publish_generation(
        test_db,
        knowledge_base=knowledge_base,
        generation=collapsed,
        user_id=USER_ID,
        effects=effects.build(),
    )

    assert not result.published
    assert 4242 in effects.deleted_rag
    assert (knowledge_base.json or {})["spec"][PENDING_INDEX_CLEANUP_KEY] == []


def _update_spec_pending(test_db: Session, knowledge_base: Kind, refs: list[str]):
    payload = dict(knowledge_base.json or {})
    spec = dict(payload.get("spec", {}))
    spec[PENDING_INDEX_CLEANUP_KEY] = refs
    payload["spec"] = spec
    knowledge_base.json = payload
    test_db.flush()


# --- what a publish records for readers -------------------------------------


def test_publishing_records_the_commit_and_time_for_the_list(
    test_db: Session, knowledge_base: Kind, effects: FakeEffects
):
    """A list would otherwise join every wiki against its generations for two
    fields. Written in the publish transaction, so they cannot drift from the
    pointer they sit beside."""
    generation = _generation(test_db, knowledge_base.id)
    generation.source_snapshot = {"commit": "abc1234"}
    _page(test_db, generation, "index", "body")
    test_db.flush()

    publish_generation(
        test_db,
        knowledge_base=knowledge_base,
        generation=generation,
        user_id=USER_ID,
        effects=effects.build(),
    )

    spec = (knowledge_base.json or {})["spec"]
    assert spec[PUBLISHED_COMMIT_KEY] == "abc1234"
    assert spec[PUBLISHED_AT_KEY]


def test_the_agents_declared_order_is_what_gets_recorded(
    test_db: Session, knowledge_base: Kind, effects: FakeEffects
):
    """Paths carry hierarchy and say nothing about which section comes first.
    Alphabetically "api" precedes the overview, and a wiki read that way reads
    wrong."""
    generation = _generation(test_db, knowledge_base.id)
    for path in ("api", "index", "architecture"):
        _page(test_db, generation, path, "body")
    generation.ext = {
        "content_write": {
            "summary": {"structure_order": ["index", "architecture", "api"]}
        }
    }
    test_db.flush()

    publish_generation(
        test_db,
        knowledge_base=knowledge_base,
        generation=generation,
        user_id=USER_ID,
        effects=effects.build(),
    )

    assert (knowledge_base.json or {})["spec"][PAGE_ORDER_KEY] == [
        "index",
        "architecture",
        "api",
    ]


def test_pages_the_agent_did_not_rank_follow_the_ones_it_did(
    test_db: Session, knowledge_base: Kind, effects: FakeEffects
):
    """A page added without updating the declared order must still appear, and
    appear somewhere predictable rather than at a position nobody chose."""
    generation = _generation(test_db, knowledge_base.id)
    for path in ("index", "stray"):
        _page(test_db, generation, path, "body")
    generation.ext = {"content_write": {"summary": {"structure_order": ["index"]}}}
    test_db.flush()

    publish_generation(
        test_db,
        knowledge_base=knowledge_base,
        generation=generation,
        user_id=USER_ID,
        effects=effects.build(),
    )

    assert (knowledge_base.json or {})["spec"][PAGE_ORDER_KEY] == ["index", "stray"]
