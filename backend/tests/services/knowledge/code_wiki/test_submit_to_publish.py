# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for the agent's final submission reaching the knowledge base.

The agent has one channel back to the server, and the last thing it sends through it
is a summary saying the run finished. For a code wiki that has to do more than record
a status: the version is offered to the publish gate and projected into the knowledge
base. These tests cover that handoff, including the case it must not affect — the
legacy wiki, which writes through the same endpoint and only records a status.
"""

from dataclasses import dataclass, field
from datetime import datetime

import pytest
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.knowledge import KnowledgeDocument
from app.models.user import User
from app.models.wiki import (
    WikiContent,
    WikiGeneration,
    WikiGenerationStatus,
    WikiGenerationType,
)
from app.schemas.wiki import (
    WikiContentSection,
    WikiContentSummary,
    WikiContentWriteRequest,
)
from app.services.knowledge.code_wiki.generation import published_commit
from app.services.knowledge.code_wiki.publish_gate import PUBLISH_GATE_EXT_KEY
from app.services.knowledge.code_wiki.publisher import published_generation_id
from app.services.knowledge.code_wiki.version_store import set_page_path
from app.services.wiki_service import WikiService

HEAD = "aaaaaaa"


@dataclass
class FakeEffects:
    written: list[str] = field(default_factory=list)
    next_id: int = 9000

    def _write(self, *, filename: str, content: str) -> int:
        self.next_id += 1
        self.written.append(filename)
        return self.next_id


@pytest.fixture
def no_side_effects(monkeypatch) -> FakeEffects:
    from app.services.knowledge.code_wiki import runner
    from app.services.knowledge.code_wiki.projection import ProjectionSideEffects

    fake = FakeEffects()
    monkeypatch.setattr(
        runner,
        "build_projection_side_effects",
        lambda db, *, knowledge_base, user: ProjectionSideEffects(
            write_attachment=fake._write,
            delete_attachment=lambda _: None,
            delete_rag_document=lambda _: None,
            enqueue_reindex=lambda _: None,
        ),
    )
    return fake


@pytest.fixture
def knowledge_base(test_db: Session, test_user: User) -> Kind:
    kind = Kind(
        kind="KnowledgeBase",
        name="kb-submit",
        namespace="default",
        user_id=test_user.id,
        json={"spec": {"name": "wiki", "kbType": "code_wiki"}},
        is_active=True,
    )
    test_db.add(kind)
    test_db.flush()
    return kind


def _generation(test_db: Session, user: User, kind_id: int) -> WikiGeneration:
    record = WikiGeneration(
        project_id=0,
        kind_id=kind_id,
        user_id=user.id,
        task_id=1,
        team_id=1,
        generation_type=WikiGenerationType.FULL,
        source_snapshot={},
        status=WikiGenerationStatus.RUNNING,
        completed_at=datetime(1970, 1, 1),
    )
    test_db.add(record)
    test_db.flush()
    return record


def _seed_page(test_db: Session, generation: WikiGeneration, path: str):
    entry = WikiContent(
        generation_id=generation.id,
        type="chapter",
        title=path,
        content="body",
        parent_id=0,
    )
    set_page_path(entry, path)
    test_db.add(entry)
    test_db.flush()


def _submit(db: Session, generation: WikiGeneration, **summary_fields):
    WikiService().save_generation_contents(
        db,
        WikiContentWriteRequest(
            generation_id=generation.id,
            sections=[],
            summary=WikiContentSummary(**summary_fields),
        ),
    )


def _documents(db: Session, kind_id: int) -> list[KnowledgeDocument]:
    return (
        db.query(KnowledgeDocument).filter(KnowledgeDocument.kind_id == kind_id).all()
    )


def test_completing_a_code_wiki_run_publishes_it_into_the_knowledge_base(
    test_db: Session,
    knowledge_base: Kind,
    test_user: User,
    no_side_effects: FakeEffects,
):
    generation = _generation(test_db, test_user, knowledge_base.id)
    _seed_page(test_db, generation, "index")

    _submit(test_db, generation, status="COMPLETED", head_commit=HEAD)

    assert published_generation_id(knowledge_base) == generation.id
    assert [doc.name for doc in _documents(test_db, knowledge_base.id)] == ["index"]


def test_a_published_run_ends_completed_rather_than_running(
    test_db: Session,
    knowledge_base: Kind,
    test_user: User,
    no_side_effects: FakeEffects,
):
    generation = _generation(test_db, test_user, knowledge_base.id)
    _seed_page(test_db, generation, "index")

    _submit(test_db, generation, status="COMPLETED", head_commit=HEAD)

    test_db.refresh(generation)
    assert generation.status == WikiGenerationStatus.COMPLETED


def test_a_version_the_gate_refuses_does_not_replace_the_published_one(
    test_db: Session,
    knowledge_base: Kind,
    test_user: User,
    no_side_effects: FakeEffects,
):
    """This is why the agent's word is not enough on its own: it says the run
    succeeded, and the gate still decides whether the result may go live."""
    first = _generation(test_db, test_user, knowledge_base.id)
    for path in ("index", "one", "two", "three"):
        _seed_page(test_db, first, path)
    _submit(test_db, first, status="COMPLETED", head_commit=HEAD)

    # Empty: the gate reports a version that shrank and refuses only one that holds
    # nothing, which is a run that produced nothing rather than an empty repository.
    collapsed = _generation(test_db, test_user, knowledge_base.id)

    _submit(test_db, collapsed, status="COMPLETED", head_commit="bbbbbbb")

    test_db.refresh(collapsed)
    assert published_generation_id(knowledge_base) == first.id
    assert collapsed.ext[PUBLISH_GATE_EXT_KEY]["result"] == "rejected"
    assert {doc.name for doc in _documents(test_db, knowledge_base.id)} == {
        "index",
        "one",
        "two",
        "three",
    }


def test_the_reported_commit_reaches_the_published_version(
    test_db: Session,
    knowledge_base: Kind,
    test_user: User,
    no_side_effects: FakeEffects,
):
    generation = _generation(test_db, test_user, knowledge_base.id)
    _seed_page(test_db, generation, "index")

    _submit(test_db, generation, status="COMPLETED", head_commit=HEAD)

    assert published_commit(test_db, knowledge_base) == HEAD


def test_a_failed_submission_publishes_nothing(
    test_db: Session,
    knowledge_base: Kind,
    test_user: User,
    no_side_effects: FakeEffects,
):
    generation = _generation(test_db, test_user, knowledge_base.id)
    _seed_page(test_db, generation, "index")

    _submit(test_db, generation, status="FAILED", error_message="ran out of budget")

    test_db.refresh(generation)
    assert generation.status == WikiGenerationStatus.FAILED
    assert published_generation_id(knowledge_base) == 0
    assert _documents(test_db, knowledge_base.id) == []


def test_pages_sent_with_the_final_summary_are_published_too(
    test_db: Session,
    knowledge_base: Kind,
    test_user: User,
    no_side_effects: FakeEffects,
):
    """The agent may finish in one call, so the write must be committed first."""
    generation = _generation(test_db, test_user, knowledge_base.id)

    WikiService().save_generation_contents(
        test_db,
        WikiContentWriteRequest(
            generation_id=generation.id,
            sections=[
                WikiContentSection(
                    type="chapter",
                    title="Backend Architecture",
                    content="body",
                    path="architecture/backend",
                )
            ],
            summary=WikiContentSummary(status="COMPLETED", head_commit=HEAD),
        ),
    )

    # Named for the title, which is what a reader sees. The path stays the identity
    # in source_config, so rewording the heading renames the document without moving
    # it or changing the id the RAG index is keyed on.
    assert [doc.name for doc in _documents(test_db, knowledge_base.id)] == [
        "Backend Architecture"
    ]


def test_a_legacy_generation_only_records_its_status(
    test_db: Session, test_user: User, no_side_effects: FakeEffects
):
    """Nothing to publish into, so the old behaviour has to survive untouched."""
    generation = _generation(test_db, test_user, kind_id=0)
    _seed_page(test_db, generation, "index")

    _submit(test_db, generation, status="COMPLETED")

    test_db.refresh(generation)
    assert generation.status == WikiGenerationStatus.COMPLETED
    assert no_side_effects.written == []
