# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Applying a projection plan to the knowledge base.

The ordering here is the whole point, and it is not negotiable:

    before the transaction   write the new attachments (row and object)
    inside the transaction   repoint, insert, delete rows, drop empty folders
    after the transaction    delete superseded attachments, clear RAG, reindex

Attachment bytes live in object storage in production, so they are outside the
transaction. Writing them first costs an orphaned object when a publish fails, which a
sweep collects. Deleting them first would destroy live content that a rollback then
cannot bring back — the same act, reordered, is the difference between litter and data
loss.

The same reasoning forbids overwriting an attachment in place for an updated page: the
overwrite happens before the commit, so a failed transaction would leave the document
pointing at content that was never published and the previous content gone. Updates
therefore write a new attachment and repoint.

``KnowledgeService.delete_document`` is deliberately not used, because it commits
internally — calling it per page would turn one transaction into many. Its cascade
still has to happen, though: deleting a document row without clearing the RAG index
leaves the retrieval layer answering from a page that no longer exists and citing an
id that resolves to nothing. Since the vector store cannot join the transaction, those
deletions are recorded and retried instead.
"""

import logging
from dataclasses import dataclass, field
from typing import Callable, Optional, Protocol, Sequence

from sqlalchemy.orm import Session

from app.models.knowledge import ContentOrigin, KnowledgeDocument
from app.services.knowledge.code_wiki.page_path import split_page_path
from app.services.knowledge.code_wiki.projection_plan import (
    CONTENT_HASH_KEY,
    PAGE_PATH_KEY,
    PageSource,
    ProjectionPlan,
)

logger = logging.getLogger(__name__)

# Key under which doc_refs awaiting RAG deletion are parked on the knowledge base.
# The vector store is external, so its cleanup cannot be part of the transaction; a
# failure there must survive a restart rather than vanish into a log line.
PENDING_INDEX_CLEANUP_KEY = "pendingIndexCleanup"

DOCUMENT_EXTENSION = "md"


class AttachmentWriter(Protocol):
    """Creates attachment content. Called only before the transaction commits."""

    def __call__(self, *, filename: str, content: str) -> int:
        """Return the id of a newly created attachment."""


@dataclass
class ProjectionSideEffects:
    """Everything the projection does outside its own transaction.

    Injected rather than imported so the ordering rules above can be asserted on
    directly: a test can record the sequence of calls and prove that no attachment is
    deleted before the commit.
    """

    write_attachment: AttachmentWriter
    delete_attachment: Callable[[int], None]
    delete_rag_document: Callable[[int], None]
    enqueue_reindex: Callable[[int], None]


@dataclass(frozen=True)
class ProjectionOutcome:
    """What the projection did."""

    plan: ProjectionPlan
    created_document_ids: tuple[int, ...] = ()
    updated_document_ids: tuple[int, ...] = ()
    deleted_document_ids: tuple[int, ...] = ()
    # doc_refs whose RAG deletion did not succeed and must be retried.
    unfinished_index_cleanup: tuple[str, ...] = field(default=())


def _folder_resolver(db: Session, kind_id: int):
    """Return a function creating (or finding) the folder chain for a page path."""
    from app.models.knowledge import KnowledgeFolder

    # Loaded once. A projection touches a handful of folders and asks about them
    # repeatedly, so one query up front replaces a query per distinct folder.
    cache: dict[tuple[int, str], int] = {
        (folder.parent_id, folder.name.casefold()): folder.id
        for folder in db.query(KnowledgeFolder)
        .filter(KnowledgeFolder.kind_id == kind_id)
        .all()
    }

    def resolve(segments: Sequence[str]) -> int:
        parent_id = 0
        for segment in segments:
            key = (parent_id, segment.casefold())
            if key not in cache:
                created = KnowledgeFolder(
                    kind_id=kind_id,
                    parent_id=parent_id,
                    name=segment,
                    origin=ContentOrigin.GENERATED.value,
                )
                db.add(created)
                db.flush()
                cache[key] = created.id
            parent_id = cache[key]
        return parent_id

    return resolve


# What ``knowledge_documents.name`` will hold. The column is 255 wide while a page
# path may be 500, which is one reason the path cannot simply be the name.
MAX_DOCUMENT_NAME = 255


def _display_name(source: PageSource) -> str:
    """What a reader sees this page called.

    The agent's title, which was previously discarded — documents were named after
    the path's last segment, so "Backend Architecture" at ``architecture/backend``
    became a document called ``backend``, and two pages at ``architecture/backend``
    and ``services/backend`` were indistinguishable in any flat listing.

    Falls back to the leaf when a title is missing, because a page has to be called
    something, and truncates rather than letting the insert fail on a long one.
    """
    _, leaf = split_page_path(source.path)
    title = (source.title or "").strip() or leaf
    return title[:MAX_DOCUMENT_NAME]


def _stamp(document: KnowledgeDocument, source: PageSource) -> None:
    """Record the page identity and fingerprint the next plan compares against."""
    config = dict(document.source_config or {})
    config[PAGE_PATH_KEY] = source.path
    config[CONTENT_HASH_KEY] = source.fingerprint
    document.source_config = config


def apply_projection_plan(
    db: Session,
    *,
    kind_id: int,
    user_id: int,
    plan: ProjectionPlan,
    effects: ProjectionSideEffects,
) -> ProjectionOutcome:
    """Write a plan into the knowledge base.

    The caller owns the transaction and must commit; this function flushes but never
    commits, so that a failure anywhere leaves the knowledge base exactly as it was.

    Args:
        db: Session holding the projection transaction.
        kind_id: Knowledge base being projected into.
        user_id: Owner recorded on documents the projection creates.
        plan: What to do, from ``compute_projection_plan``.
        effects: Side effects outside the transaction.

    Returns:
        What was done, including any RAG cleanup left to retry.
    """
    resolve_folder = _folder_resolver(db, kind_id)

    # --- before the transaction commits: content into storage -------------------
    # Written first on purpose. An orphaned object is litter; content deleted before
    # a rollback is gone.
    new_attachments: dict[str, int] = {}
    for source in (*plan.adds, *(update.source for update in plan.updates)):
        _, leaf = split_page_path(source.path)
        new_attachments[source.path] = effects.write_attachment(
            filename=f"{leaf}.{DOCUMENT_EXTENSION}",
            content=source.content,
        )

    def add_document(source: PageSource) -> int:
        """Create the row for a page that is not in the knowledge base."""
        folders, _ = split_page_path(source.path)
        document = KnowledgeDocument(
            kind_id=kind_id,
            attachment_id=new_attachments[source.path],
            name=_display_name(source),
            file_extension=DOCUMENT_EXTENSION,
            file_size=len(source.content.encode("utf-8")),
            user_id=user_id,
            folder_id=resolve_folder(folders),
            origin=ContentOrigin.GENERATED.value,
            # Left inactive; the existing indexing state machine turns a document on
            # once its index succeeds, which is how every other document behaves.
            is_active=False,
        )
        _stamp(document, source)
        db.add(document)
        db.flush()
        return document.id

    # --- inside the transaction: rows only --------------------------------------
    created: list[int] = []
    for source in plan.adds:
        created.append(add_document(source))

    superseded_attachments: list[int] = []
    updated: list[int] = []
    for update in plan.updates:
        document = db.get(KnowledgeDocument, update.existing.document_id)
        if document is None:
            # The row went away between planning and here. Skipping would leave the
            # published version missing a page the plan accounted for, and strand the
            # attachment already written for it, so it is added instead.
            logger.warning(
                "[code_wiki] document %s vanished before projection; adding it back",
                update.existing.document_id,
            )
            created.append(add_document(update.source))
            continue
        if document.attachment_id:
            superseded_attachments.append(document.attachment_id)
        document.attachment_id = new_attachments[update.source.path]
        document.file_size = len(update.source.content.encode("utf-8"))
        # Follows the title, which is why the fingerprint covers it: a reworded
        # heading has to reach the document's name, not just its content.
        document.name = _display_name(update.source)
        _stamp(document, update.source)
        updated.append(document.id)

    removed_refs: list[str] = []
    deleted: list[int] = []
    for page in plan.deletes:
        document = db.get(KnowledgeDocument, page.document_id)
        if document is None:
            continue
        if document.attachment_id:
            superseded_attachments.append(document.attachment_id)
        converted = document.converted_attachment_id
        if converted:
            superseded_attachments.append(converted)
        # The RAG index keys documents by their id as a string; capture it before the
        # row is gone, because after the commit there is nothing left to derive it from.
        removed_refs.append(str(document.id))
        deleted.append(document.id)
        db.delete(document)

    db.flush()
    _remove_emptied_generated_folders(db, kind_id)
    db.flush()

    return ProjectionOutcome(
        plan=plan,
        created_document_ids=tuple(created),
        updated_document_ids=tuple(updated),
        deleted_document_ids=tuple(deleted),
        unfinished_index_cleanup=tuple(removed_refs),
    )


def finish_projection(
    outcome: ProjectionOutcome,
    *,
    superseded_attachment_ids: Sequence[int],
    effects: ProjectionSideEffects,
) -> tuple[str, ...]:
    """Run the work that must wait until the transaction has committed.

    Every step here is retriable and none of it can undo the publish, so a failure is
    reported rather than raised: the pages are already correct, and refusing to
    acknowledge that would only cause the whole version to be produced again.

    Returns:
        doc_refs whose RAG deletion failed and must be retried.
    """
    for attachment_id in superseded_attachment_ids:
        try:
            effects.delete_attachment(attachment_id)
        except Exception as exc:  # pragma: no cover - defensive
            logger.warning(
                "[code_wiki] superseded attachment %s not deleted: %s",
                attachment_id,
                exc,
            )

    unfinished: list[str] = []
    for doc_ref in outcome.unfinished_index_cleanup:
        try:
            effects.delete_rag_document(int(doc_ref))
        except Exception as exc:
            logger.warning(
                "[code_wiki] RAG cleanup for doc_ref %s failed, will retry: %s",
                doc_ref,
                exc,
            )
            unfinished.append(doc_ref)

    for document_id in (
        *outcome.created_document_ids,
        *outcome.updated_document_ids,
    ):
        try:
            effects.enqueue_reindex(document_id)
        except Exception as exc:  # pragma: no cover - defensive
            logger.warning(
                "[code_wiki] reindex not enqueued for document %s: %s",
                document_id,
                exc,
            )

    return tuple(unfinished)


def _remove_emptied_generated_folders(db: Session, kind_id: int) -> None:
    """Drop generated folders left with no documents and no children.

    Scoped to generated folders: a user folder that happens to be empty is theirs to
    keep, and the projection has no business tidying it away.
    """
    from app.models.knowledge import KnowledgeFolder

    folders = (
        db.query(KnowledgeFolder)
        .filter(
            KnowledgeFolder.kind_id == kind_id,
            KnowledgeFolder.origin == ContentOrigin.GENERATED.value,
        )
        .all()
    )
    if not folders:
        return

    used_folder_ids = {
        row[0]
        for row in db.query(KnowledgeDocument.folder_id)
        .filter(KnowledgeDocument.kind_id == kind_id)
        .distinct()
        .all()
    }

    # Walked deepest-first. Emptying a leaf can empty its parent, so a parent is only
    # judged once its children have been — which is what the old repeat-until-stable
    # loop was doing, one re-query per level.
    children: dict[int, list[KnowledgeFolder]] = {}
    for folder in folders:
        children.setdefault(folder.parent_id, []).append(folder)

    doomed: set[int] = set()

    def survives(folder: KnowledgeFolder) -> bool:
        # Every child is visited before the decision: a short circuit would leave the
        # ones after the first survivor unexamined, and they may be empty themselves.
        kept_child = any([survives(child) for child in children.get(folder.id, ())])
        if folder.id in used_folder_ids or kept_child:
            return True
        doomed.add(folder.id)
        return False

    # Roots are the generated folders whose parent is not itself generated: the tree
    # top (parent 0) and anything a user folder contains. Depth is capped at four, so
    # the recursion cannot run away.
    generated_ids = {folder.id for folder in folders}
    for folder in folders:
        if folder.parent_id not in generated_ids:
            survives(folder)

    if not doomed:
        return
    for folder in folders:
        if folder.id in doomed:
            db.delete(folder)
    db.flush()
