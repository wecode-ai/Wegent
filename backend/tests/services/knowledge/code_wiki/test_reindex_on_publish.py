# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Publishing a revised page has to reach the index, not just the reader.

A page's new text is projected onto its document and then queued for indexing. The
queue call passed replace_active but not allow_if_success, and the state machine
refuses a document whose last index succeeded — which is every page that has ever
been published. So an incremental run rewrote a page, the reader saw the new text,
and chat and search went on answering from the version before it.

The publish tests could not catch this: they stub the side effects, so nothing in
them reaches the state machine that made the decision.
"""

from unittest.mock import patch

import pytest
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.knowledge import KnowledgeDocument
from app.models.user import User
from app.schemas.knowledge import DocumentIndexStatus
from app.services.knowledge.code_wiki.side_effects import _enqueue_reindex
from app.services.knowledge.index_state_machine import prepare_document_index_enqueue


@pytest.fixture
def knowledge_base(test_db: Session, test_user: User) -> Kind:
    kind = Kind(
        kind="KnowledgeBase",
        name="kb-reindex",
        namespace="default",
        user_id=test_user.id,
        json={"spec": {"name": "wiki", "kbType": "code_wiki"}},
        is_active=True,
    )
    test_db.add(kind)
    test_db.commit()
    return kind


def _published_page(
    test_db: Session, test_user: User, knowledge_base: Kind
) -> KnowledgeDocument:
    """A page that has already been indexed once, which is the state that broke."""
    document = KnowledgeDocument(
        kind_id=knowledge_base.id,
        attachment_id=0,
        name="architecture",
        file_extension="md",
        file_size=64,
        user_id=test_user.id,
        is_active=True,
        status="enabled",
        source_type="file",
        index_status=DocumentIndexStatus.SUCCESS,
        index_generation=1,
    )
    test_db.add(document)
    test_db.commit()
    return document


def test_a_revised_page_is_queued_even_though_it_indexed_before(
    test_db: Session, test_user: User, knowledge_base: Kind
):
    """The state machine's own answer, with the flags the publish path sends."""
    document = _published_page(test_db, test_user, knowledge_base)

    decision = prepare_document_index_enqueue(
        test_db, document.id, allow_if_success=True, replace_active=True
    )

    assert decision.should_enqueue is True


def test_without_the_flag_a_revised_page_is_silently_skipped(
    test_db: Session, test_user: User, knowledge_base: Kind
):
    """The behaviour being guarded against, stated so the flag cannot be dropped as
    redundant: replace_active alone is not enough.
    """
    document = _published_page(test_db, test_user, knowledge_base)

    decision = prepare_document_index_enqueue(test_db, document.id, replace_active=True)

    assert decision.should_enqueue is False
    assert decision.reason == "already_indexed"


def test_the_publish_path_sends_the_flag(
    test_db: Session, test_user: User, knowledge_base: Kind
):
    """Ties the call site to the two tests above. Neither of them fails if the
    publish path stops asking for it, which is exactly what happened.
    """
    document = _published_page(test_db, test_user, knowledge_base)

    with patch(
        "app.services.knowledge.orchestrator.knowledge_orchestrator"
        "._schedule_indexing_celery"
    ) as schedule:
        _enqueue_reindex(
            test_db,
            knowledge_base=knowledge_base,
            user=test_user,
            document_id=document.id,
        )

    assert schedule.call_args.kwargs["allow_if_success"] is True
    assert schedule.call_args.kwargs["replace_active"] is True
