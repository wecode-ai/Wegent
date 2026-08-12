# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Publishing a version through the real attachment and indexing services.

Every other test for this pipeline injects fakes, which proves the logic but not the
assumptions it rests on. This one uses the real attachment store and asserts on what
a reader would actually get, so that a wrong signature or a document that never
becomes visible fails here rather than in production.
"""

from datetime import datetime
from unittest.mock import patch

import pytest
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.knowledge import (
    ContentOrigin,
    DocumentIndexStatus,
    DocumentStatus,
    KnowledgeDocument,
)
from app.models.subtask_context import SubtaskContext
from app.models.user import User
from app.models.wiki import (
    WikiContent,
    WikiGeneration,
    WikiGenerationStatus,
    WikiGenerationType,
)
from app.services.knowledge.code_wiki.projection_plan import PAGE_PATH_KEY
from app.services.knowledge.code_wiki.publisher import (
    publish_generation,
    published_generation_id,
)
from app.services.knowledge.code_wiki.side_effects import (
    build_projection_side_effects,
)
from app.services.knowledge.code_wiki.version_store import set_page_path
from app.services.knowledge.index_state_machine import (
    mark_document_index_succeeded,
)
from app.services.knowledge.orchestrator import knowledge_orchestrator


@pytest.fixture
def knowledge_base(test_db: Session, test_user: User) -> Kind:
    kind = Kind(
        kind="KnowledgeBase",
        name="kb-wiki-e2e",
        namespace="default",
        user_id=test_user.id,
        json={"spec": {"name": "wiki", "kbType": "code_wiki"}},
        is_active=True,
    )
    test_db.add(kind)
    test_db.flush()
    return kind


@pytest.fixture
def generation(test_db: Session, knowledge_base: Kind, test_user: User):
    def build() -> WikiGeneration:
        record = WikiGeneration(
            project_id=1,
            kind_id=knowledge_base.id,
            user_id=test_user.id,
            task_id=0,
            team_id=1,
            generation_type=WikiGenerationType.FULL,
            source_snapshot={},
            status=WikiGenerationStatus.COMPLETED,
            completed_at=datetime(1970, 1, 1),
        )
        test_db.add(record)
        test_db.flush()
        return record

    return build


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


def _publish(test_db, knowledge_base, generation, test_user, enqueued):
    """Publish with real attachment storage; only the queue is intercepted."""
    effects = build_projection_side_effects(
        test_db, knowledge_base=knowledge_base, user=test_user
    )
    with patch(
        "app.services.knowledge.code_wiki.side_effects._enqueue_reindex",
        side_effect=lambda db, **kw: enqueued.append(kw["document_id"]),
    ):
        return publish_generation(
            test_db,
            knowledge_base=knowledge_base,
            generation=generation,
            user_id=test_user.id,
            effects=effects,
        )


def test_a_published_page_has_real_content_behind_it(
    test_db: Session, knowledge_base: Kind, test_user: User, generation
):
    """The document must point at an attachment that actually holds the page."""
    version = generation()
    _page(test_db, version, "architecture/backend", "# Backend\n\nHow it works.")
    enqueued: list[int] = []

    result = _publish(test_db, knowledge_base, version, test_user, enqueued)

    assert result.published
    document = (
        test_db.query(KnowledgeDocument)
        .filter(KnowledgeDocument.kind_id == knowledge_base.id)
        .one()
    )
    attachment = test_db.get(SubtaskContext, document.attachment_id)
    assert attachment is not None
    assert attachment.extracted_text.strip().startswith("# Backend")
    assert document.file_size == len("# Backend\n\nHow it works.".encode("utf-8"))


def test_a_published_page_is_queued_for_indexing(
    test_db: Session, knowledge_base: Kind, test_user: User, generation
):
    version = generation()
    _page(test_db, version, "index", "overview")
    enqueued: list[int] = []

    _publish(test_db, knowledge_base, version, test_user, enqueued)

    document = (
        test_db.query(KnowledgeDocument)
        .filter(KnowledgeDocument.kind_id == knowledge_base.id)
        .one()
    )
    assert enqueued == [document.id]


def test_a_published_page_uses_the_normal_document_summary_flow(
    test_db: Session, knowledge_base: Kind, test_user: User, generation
):
    """Generated pages need the same post-index summary as user documents."""
    version = generation()
    _page(test_db, version, "index", "overview")
    effects = build_projection_side_effects(
        test_db, knowledge_base=knowledge_base, user=test_user
    )

    with patch.object(
        knowledge_orchestrator,
        "_schedule_indexing_celery",
        return_value={"scheduled": True},
    ) as schedule_indexing:
        result = publish_generation(
            test_db,
            knowledge_base=knowledge_base,
            generation=version,
            user_id=test_user.id,
            effects=effects,
        )

    document = (
        test_db.query(KnowledgeDocument)
        .filter(KnowledgeDocument.kind_id == knowledge_base.id)
        .one()
    )
    assert result.published
    schedule_indexing.assert_called_once_with(
        db=test_db,
        knowledge_base=knowledge_base,
        document=document,
        user=test_user,
        trigger_summary=True,
        replace_active=True,
        allow_if_success=True,
    )


def test_a_page_stays_invisible_until_its_index_succeeds(
    test_db: Session, knowledge_base: Kind, test_user: User, generation
):
    """The assumption the whole publish path rests on.

    Pages are created switched off and the indexing state machine turns them on. If
    that did not hold, a published wiki would be silently unreadable while every unit
    test still passed.
    """
    from app.services.knowledge.index_state_machine import (
        prepare_document_index_enqueue,
    )

    version = generation()
    _page(test_db, version, "index", "overview")
    enqueued: list[int] = []

    _publish(test_db, knowledge_base, version, test_user, enqueued)

    document = (
        test_db.query(KnowledgeDocument)
        .filter(KnowledgeDocument.kind_id == knowledge_base.id)
        .one()
    )
    assert document.is_active is False
    assert document.status == DocumentStatus.DISABLED

    # The real path, not a shortcut: the state machine only accepts a success for a
    # document it queued, so jumping straight to it proves nothing.
    decision = prepare_document_index_enqueue(test_db, document_id=document.id)
    assert decision.should_enqueue
    mark_document_index_succeeded(
        test_db, document_id=document.id, generation=decision.generation
    )
    test_db.refresh(document)

    assert document.is_active is True
    assert document.status == DocumentStatus.ENABLED


def test_indexing_is_not_blocked_by_the_page_being_switched_off(
    test_db: Session, knowledge_base: Kind, test_user: User, generation
):
    """Enqueueing looks at the index status, not at whether the page is visible."""
    version = generation()
    _page(test_db, version, "index", "overview")
    enqueued: list[int] = []
    _publish(test_db, knowledge_base, version, test_user, enqueued)

    document = (
        test_db.query(KnowledgeDocument)
        .filter(KnowledgeDocument.kind_id == knowledge_base.id)
        .one()
    )

    from app.services.knowledge.index_state_machine import (
        prepare_document_index_enqueue,
    )

    decision = prepare_document_index_enqueue(test_db, document_id=document.id)

    assert decision.should_enqueue is True


def test_a_second_publish_replaces_the_content_and_keeps_the_document(
    test_db: Session, knowledge_base: Kind, test_user: User, generation
):
    first = generation()
    _page(test_db, first, "index", "first draft")
    enqueued: list[int] = []
    _publish(test_db, knowledge_base, first, test_user, enqueued)
    document_id = (
        test_db.query(KnowledgeDocument)
        .filter(KnowledgeDocument.kind_id == knowledge_base.id)
        .one()
        .id
    )
    original_attachment = test_db.get(KnowledgeDocument, document_id).attachment_id

    second = generation()
    _page(test_db, second, "index", "second draft")
    _publish(test_db, knowledge_base, second, test_user, enqueued)

    document = test_db.get(KnowledgeDocument, document_id)
    assert document is not None, "the document id must survive a rewrite"
    assert document.attachment_id != original_attachment
    attachment = test_db.get(SubtaskContext, document.attachment_id)
    assert "second draft" in attachment.extracted_text
    assert published_generation_id(knowledge_base) == second.id


def test_an_unchanged_page_writes_no_new_attachment(
    test_db: Session, knowledge_base: Kind, test_user: User, generation
):
    first = generation()
    _page(test_db, first, "index", "identical")
    enqueued: list[int] = []
    _publish(test_db, knowledge_base, first, test_user, enqueued)
    attachment_count = test_db.query(SubtaskContext).count()

    second = generation()
    _page(test_db, second, "index", "identical")
    _publish(test_db, knowledge_base, second, test_user, enqueued)

    assert test_db.query(SubtaskContext).count() == attachment_count


def test_a_removed_page_takes_its_attachment_with_it(
    test_db: Session, knowledge_base: Kind, test_user: User, generation
):
    first = generation()
    _page(test_db, first, "index", "kept")
    _page(test_db, first, "doomed", "removed later")
    enqueued: list[int] = []
    _publish(test_db, knowledge_base, first, test_user, enqueued)
    doomed = (
        test_db.query(KnowledgeDocument)
        .filter(KnowledgeDocument.name == "doomed")
        .one()
    )
    doomed_attachment = doomed.attachment_id

    second = generation()
    _page(test_db, second, "index", "kept")
    result = _publish(test_db, knowledge_base, second, test_user, enqueued)

    # Stated rather than assumed: removing one of two pages sits exactly on the
    # gate's threshold, and everything below only means something if it published.
    assert result.published
    assert test_db.get(KnowledgeDocument, doomed.id) is None
    assert test_db.get(SubtaskContext, doomed_attachment) is None


def test_the_folder_tree_is_built_from_the_page_paths(
    test_db: Session, knowledge_base: Kind, test_user: User, generation
):
    version = generation()
    _page(test_db, version, "index", "root page")
    _page(test_db, version, "architecture/backend", "nested page")
    enqueued: list[int] = []

    _publish(test_db, knowledge_base, version, test_user, enqueued)

    documents = {
        (document.source_config or {}).get(PAGE_PATH_KEY): document
        for document in test_db.query(KnowledgeDocument)
        .filter(KnowledgeDocument.kind_id == knowledge_base.id)
        .all()
    }
    assert documents["index"].folder_id == 0
    assert documents["architecture/backend"].folder_id != 0
    assert documents["architecture/backend"].origin == ContentOrigin.GENERATED.value


def test_a_fresh_page_starts_unindexed(
    test_db: Session, knowledge_base: Kind, test_user: User, generation
):
    version = generation()
    _page(test_db, version, "index", "overview")
    enqueued: list[int] = []

    _publish(test_db, knowledge_base, version, test_user, enqueued)

    document = (
        test_db.query(KnowledgeDocument)
        .filter(KnowledgeDocument.kind_id == knowledge_base.id)
        .one()
    )
    assert document.index_status == DocumentIndexStatus.NOT_INDEXED
