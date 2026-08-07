# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for applying a projection plan.

Attachment bytes live outside the transaction, so the order in which they are written
and deleted decides whether a failed publish leaves litter or destroys content. These
tests record the sequence of side effects and assert on it directly.
"""

from dataclasses import dataclass, field

import pytest
from sqlalchemy.orm import Session

from app.models.knowledge import ContentOrigin, KnowledgeDocument, KnowledgeFolder
from app.services.knowledge.code_wiki.projection import (
    ProjectionSideEffects,
    apply_projection_plan,
    finish_projection,
)
from app.services.knowledge.code_wiki.projection_plan import (
    CONTENT_HASH_KEY,
    PAGE_PATH_KEY,
    PageSource,
    ProjectedPage,
    compute_projection_plan,
    content_fingerprint,
)

KIND_ID = 501
USER_ID = 9


@dataclass
class RecordingEffects:
    """Records every side effect in order, so ordering can be asserted on."""

    calls: list[tuple[str, object]] = field(default_factory=list)
    next_attachment_id: int = 1000
    failing_rag_refs: set[int] = field(default_factory=set)

    def as_side_effects(self) -> ProjectionSideEffects:
        return ProjectionSideEffects(
            write_attachment=self._write,
            delete_attachment=self._delete_attachment,
            delete_rag_document=self._delete_rag,
            enqueue_reindex=self._enqueue,
        )

    def _write(self, *, filename: str, content: str) -> int:
        self.next_attachment_id += 1
        self.calls.append(("write_attachment", filename))
        return self.next_attachment_id

    def _delete_attachment(self, attachment_id: int) -> None:
        self.calls.append(("delete_attachment", attachment_id))

    def _delete_rag(self, doc_ref: int) -> None:
        if doc_ref in self.failing_rag_refs:
            raise RuntimeError("vector store unavailable")
        self.calls.append(("delete_rag", doc_ref))

    def _enqueue(self, document_id: int) -> None:
        self.calls.append(("enqueue_reindex", document_id))

    def names(self) -> list[str]:
        return [name for name, _ in self.calls]


@pytest.fixture
def effects() -> RecordingEffects:
    return RecordingEffects()


def _source(path: str, content: str = "body") -> PageSource:
    return PageSource(path=path, title=path.rsplit("/", 1)[-1], content=content)


def _existing_document(
    db: Session, path: str, content: str, *, attachment_id: int = 1
) -> KnowledgeDocument:
    folders = path.split("/")[:-1]
    parent_id = 0
    for segment in folders:
        folder = KnowledgeFolder(
            kind_id=KIND_ID,
            parent_id=parent_id,
            name=segment,
            origin=ContentOrigin.GENERATED.value,
        )
        db.add(folder)
        db.flush()
        parent_id = folder.id

    # Mirrors _source: the title is the leaf, so an existing row and a fresh source
    # for the same path fingerprint identically and count as unchanged.
    title = path.rsplit("/", 1)[-1]
    document = KnowledgeDocument(
        kind_id=KIND_ID,
        attachment_id=attachment_id,
        name=title,
        file_extension="md",
        file_size=len(content),
        user_id=USER_ID,
        folder_id=parent_id,
        origin=ContentOrigin.GENERATED.value,
        source_config={
            PAGE_PATH_KEY: path,
            CONTENT_HASH_KEY: content_fingerprint(title, content),
        },
    )
    db.add(document)
    db.flush()
    return document


def _projected(document: KnowledgeDocument) -> ProjectedPage:
    config = document.source_config or {}
    return ProjectedPage(
        document_id=document.id,
        path=config[PAGE_PATH_KEY],
        content_hash=config[CONTENT_HASH_KEY],
    )


def _apply(db: Session, plan, effects: RecordingEffects):
    return apply_projection_plan(
        db,
        kind_id=KIND_ID,
        user_id=USER_ID,
        plan=plan,
        effects=effects.as_side_effects(),
    )


# --- ordering --------------------------------------------------------------


def test_attachments_are_written_before_any_row_changes(
    test_db: Session, effects: RecordingEffects
):
    """Writing first costs an orphaned object on failure; the reverse costs data."""
    plan = compute_projection_plan([_source("index")], [])

    _apply(test_db, plan, effects)

    assert effects.names() == ["write_attachment"]


def test_no_attachment_is_deleted_before_the_transaction_commits(
    test_db: Session, effects: RecordingEffects
):
    """A rollback after deleting bytes cannot bring them back."""
    existing = _existing_document(test_db, "index", "old", attachment_id=77)
    plan = compute_projection_plan([_source("index", "new")], [_projected(existing)])

    _apply(test_db, plan, effects)

    assert "delete_attachment" not in effects.names()


def test_cleanup_and_reindex_only_run_after_the_commit(
    test_db: Session, effects: RecordingEffects
):
    existing = _existing_document(test_db, "index", "old", attachment_id=77)
    plan = compute_projection_plan([_source("index", "new")], [_projected(existing)])

    outcome = _apply(test_db, plan, effects)
    before_commit = list(effects.names())
    finish_projection(
        outcome, superseded_attachment_ids=[77], effects=effects.as_side_effects()
    )

    assert before_commit == ["write_attachment"]
    assert effects.names()[1:] == ["delete_attachment", "enqueue_reindex"]


# --- what each case does ---------------------------------------------------


def test_an_added_page_becomes_an_inactive_document_in_its_folder(
    test_db: Session, effects: RecordingEffects
):
    plan = compute_projection_plan([_source("architecture/backend")], [])

    outcome = _apply(test_db, plan, effects)

    document = test_db.get(KnowledgeDocument, outcome.created_document_ids[0])
    assert document.name == "backend"
    assert document.origin == ContentOrigin.GENERATED.value
    # Left off until indexing succeeds, exactly as any other document is.
    assert document.is_active is False
    folder = test_db.get(KnowledgeFolder, document.folder_id)
    assert folder.name == "architecture"
    assert folder.origin == ContentOrigin.GENERATED.value


def test_an_updated_page_keeps_its_document_id(
    test_db: Session, effects: RecordingEffects
):
    """The reason path identity exists: the RAG index is keyed on this id."""
    existing = _existing_document(test_db, "index", "old", attachment_id=77)
    original_id = existing.id
    plan = compute_projection_plan([_source("index", "new")], [_projected(existing)])

    outcome = _apply(test_db, plan, effects)

    assert outcome.updated_document_ids == (original_id,)


def test_an_updated_page_repoints_instead_of_overwriting(
    test_db: Session, effects: RecordingEffects
):
    """Overwriting happens before the commit, so a rollback would lose both versions."""
    existing = _existing_document(test_db, "index", "old", attachment_id=77)
    plan = compute_projection_plan([_source("index", "new")], [_projected(existing)])

    _apply(test_db, plan, effects)

    assert existing.attachment_id != 77


def test_a_page_whose_row_vanished_is_added_back_rather_than_lost(
    test_db: Session, effects: RecordingEffects
):
    """The plan counted it as an update, so skipping it would leave the published
    version short a page and strand the attachment already written for it."""
    existing = _existing_document(test_db, "index", "old", attachment_id=77)
    plan = compute_projection_plan([_source("index", "new")], [_projected(existing)])
    test_db.delete(existing)
    test_db.flush()

    outcome = _apply(test_db, plan, effects)

    assert outcome.updated_document_ids == ()
    assert len(outcome.created_document_ids) == 1
    restored = test_db.get(KnowledgeDocument, outcome.created_document_ids[0])
    assert restored.name == "index"


def test_a_removed_page_records_its_doc_ref_before_the_row_is_gone(
    test_db: Session, effects: RecordingEffects
):
    """After the commit there is nothing left to derive the RAG key from."""
    existing = _existing_document(test_db, "modules/legacy", "body")
    doomed_id = existing.id
    plan = compute_projection_plan([], [_projected(existing)])

    outcome = _apply(test_db, plan, effects)

    assert outcome.deleted_document_ids == (doomed_id,)
    assert outcome.unfinished_index_cleanup == (str(doomed_id),)
    assert test_db.get(KnowledgeDocument, doomed_id) is None


def test_an_unchanged_page_causes_no_side_effects_at_all(
    test_db: Session, effects: RecordingEffects
):
    existing = _existing_document(test_db, "index", "same")
    plan = compute_projection_plan([_source("index", "same")], [_projected(existing)])

    outcome = _apply(test_db, plan, effects)

    assert effects.calls == []
    assert outcome.created_document_ids == ()
    assert outcome.updated_document_ids == ()


def test_the_fingerprint_is_stamped_so_the_next_run_can_skip(
    test_db: Session, effects: RecordingEffects
):
    plan = compute_projection_plan([_source("index", "v1")], [])

    outcome = _apply(test_db, plan, effects)

    document = test_db.get(KnowledgeDocument, outcome.created_document_ids[0])
    assert document.source_config[CONTENT_HASH_KEY] == content_fingerprint(
        "index", "v1"
    )
    assert document.source_config[PAGE_PATH_KEY] == "index"


# --- folders ---------------------------------------------------------------


def test_a_folder_emptied_by_deletion_is_removed(
    test_db: Session, effects: RecordingEffects
):
    existing = _existing_document(test_db, "modules/legacy", "body")
    plan = compute_projection_plan([], [_projected(existing)])

    _apply(test_db, plan, effects)

    assert (
        test_db.query(KnowledgeFolder)
        .filter(KnowledgeFolder.kind_id == KIND_ID)
        .count()
        == 0
    )


def test_a_whole_branch_emptied_by_deletion_is_removed(
    test_db: Session, effects: RecordingEffects
):
    """Emptying a leaf empties its parent, and that one its parent. Judging a folder
    before its children would keep every level above the last page alive."""
    existing = _existing_document(test_db, "architecture/backend/api", "body")
    plan = compute_projection_plan([], [_projected(existing)])

    _apply(test_db, plan, effects)

    assert (
        test_db.query(KnowledgeFolder)
        .filter(KnowledgeFolder.kind_id == KIND_ID)
        .count()
        == 0
    )


def test_a_branch_is_kept_while_any_page_below_it_survives(
    test_db: Session, effects: RecordingEffects
):
    """The other half of the same rule: a deep survivor keeps its whole ancestry."""
    doomed = _existing_document(test_db, "architecture/legacy", "body")
    kept = _existing_document(test_db, "architecture/backend/api", "body")
    plan = compute_projection_plan(
        [_source("architecture/backend/api", "body")],
        [_projected(doomed), _projected(kept)],
    )

    _apply(test_db, plan, effects)

    names = {
        folder.name
        for folder in test_db.query(KnowledgeFolder)
        .filter(KnowledgeFolder.kind_id == KIND_ID)
        .all()
    }
    assert names == {"architecture", "backend"}


def test_an_empty_user_folder_is_left_alone(
    test_db: Session, effects: RecordingEffects
):
    """Tidying it away would be the projection reaching outside what it owns."""
    user_folder = KnowledgeFolder(
        kind_id=KIND_ID,
        parent_id=0,
        name="my notes",
        origin=ContentOrigin.USER.value,
    )
    test_db.add(user_folder)
    test_db.flush()

    _apply(test_db, compute_projection_plan([], []), effects)

    assert test_db.get(KnowledgeFolder, user_folder.id) is not None


def test_folders_are_reused_rather_than_duplicated(
    test_db: Session, effects: RecordingEffects
):
    plan = compute_projection_plan(
        [_source("architecture/backend"), _source("architecture/frontend")], []
    )

    _apply(test_db, plan, effects)

    assert (
        test_db.query(KnowledgeFolder)
        .filter(
            KnowledgeFolder.kind_id == KIND_ID, KnowledgeFolder.name == "architecture"
        )
        .count()
        == 1
    )


# --- retriable cleanup -----------------------------------------------------


def test_a_failed_rag_deletion_is_reported_for_retry_not_raised(
    test_db: Session, effects: RecordingEffects
):
    """The pages are already correct; failing the publish would regenerate them all."""
    existing = _existing_document(test_db, "modules/legacy", "body")
    doomed_id = existing.id
    effects.failing_rag_refs.add(doomed_id)
    plan = compute_projection_plan([], [_projected(existing)])

    outcome = _apply(test_db, plan, effects)
    unfinished = finish_projection(
        outcome, superseded_attachment_ids=[], effects=effects.as_side_effects()
    )

    assert unfinished == (str(doomed_id),)


def test_successful_cleanup_leaves_nothing_to_retry(
    test_db: Session, effects: RecordingEffects
):
    existing = _existing_document(test_db, "modules/legacy", "body")
    plan = compute_projection_plan([], [_projected(existing)])

    outcome = _apply(test_db, plan, effects)
    unfinished = finish_projection(
        outcome, superseded_attachment_ids=[], effects=effects.as_side_effects()
    )

    assert unfinished == ()


def test_user_content_is_never_touched(test_db: Session, effects: RecordingEffects):
    """It is not regenerable, so a mistaken delete here is unrecoverable."""
    user_document = KnowledgeDocument(
        kind_id=KIND_ID,
        attachment_id=5,
        name="my note",
        file_extension="md",
        file_size=4,
        user_id=USER_ID,
        folder_id=0,
        origin=ContentOrigin.USER.value,
    )
    test_db.add(user_document)
    test_db.flush()

    # The caller scopes ``existing`` to generated pages, so user content simply is
    # not in the comparison — this asserts the projection does not find it anyway.
    _apply(test_db, compute_projection_plan([], []), effects)

    assert test_db.get(KnowledgeDocument, user_document.id) is not None


# --- what a page is called --------------------------------------------------


def test_a_page_is_named_after_its_title_not_its_path(
    test_db: Session, effects: RecordingEffects
):
    """The title used to be discarded, so "Backend Architecture" at
    architecture/backend became a document called "backend" — and two pages at
    architecture/backend and services/backend were indistinguishable anywhere the
    path was not also shown."""
    source = PageSource(
        path="architecture/backend", title="Backend Architecture", content="body"
    )
    plan = compute_projection_plan([source], [])

    outcome = _apply(test_db, plan, effects)

    document = test_db.get(KnowledgeDocument, outcome.created_document_ids[0])
    assert document.name == "Backend Architecture"
    # The path stays the identity, untouched by what the page is called.
    assert document.source_config[PAGE_PATH_KEY] == "architecture/backend"


def test_a_page_without_a_title_falls_back_to_its_path(
    test_db: Session, effects: RecordingEffects
):
    """A page has to be called something, and refusing the publish over a missing
    heading would discard a version that is otherwise fine."""
    source = PageSource(path="architecture/backend", title="   ", content="body")
    plan = compute_projection_plan([source], [])

    outcome = _apply(test_db, plan, effects)

    assert test_db.get(KnowledgeDocument, outcome.created_document_ids[0]).name == (
        "backend"
    )


def test_an_overlong_title_is_truncated_rather_than_failing_the_insert(
    test_db: Session, effects: RecordingEffects
):
    """The column is 255 wide; a long heading must not take the whole publish down."""
    source = PageSource(path="index", title="x" * 400, content="body")
    plan = compute_projection_plan([source], [])

    outcome = _apply(test_db, plan, effects)

    name = test_db.get(KnowledgeDocument, outcome.created_document_ids[0]).name
    assert len(name) == 255


def test_rewording_a_title_renames_the_document_in_place(
    test_db: Session, effects: RecordingEffects
):
    """It keeps its id, so the RAG index entry and any stored citation survive."""
    existing = _existing_document(test_db, "index", "body")
    original_id = existing.id
    renamed = PageSource(path="index", title="A Better Heading", content="body")
    plan = compute_projection_plan([renamed], [_projected(existing)])

    outcome = _apply(test_db, plan, effects)

    assert outcome.updated_document_ids == (original_id,)
    assert test_db.get(KnowledgeDocument, original_id).name == "A Better Heading"
