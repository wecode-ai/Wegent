# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Publishing a code wiki version.

This is the one place that moves ``spec.publishedGenerationId``. Everything else about
"which version is live" is derived from that pointer; nothing infers it from the newest
completed generation, because a generation can finish and still be rejected.

The sequence is deliberately linear:

1. read the version and the pages the knowledge base currently holds,
2. judge the version against the published one,
3. plan the difference,
4. apply the rows, advance the pointer, and commit both together,
5. clean up what could not be part of that transaction.

The pointer moves *inside* the transaction that writes the rows, not after it. They
describe one fact — which version the knowledge base holds — and committing them
separately would leave a window where the pointer and the content disagree, in a
process that can die at any point. Step 5 is outside because the vector store and the
indexing queue cannot join a database transaction; what it cannot finish is parked and
swept later.

A rollback is the same operation with an older version as its input, which is why no
separate machinery exists for it.
"""

import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Optional, Sequence

from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.knowledge import KnowledgeDocument
from app.models.wiki import WikiContent, WikiGeneration, WikiGenerationStatus
from app.services.knowledge.code_wiki.page_path import collation_key
from app.services.knowledge.code_wiki.projection import (
    PENDING_INDEX_CLEANUP_KEY,
    ProjectionSideEffects,
    apply_projection_plan,
    finish_projection,
)
from app.services.knowledge.code_wiki.projection_plan import (
    CONTENT_HASH_KEY,
    PAGE_PATH_KEY,
    PageSource,
    ProjectedPage,
    ProjectionPlan,
    compute_projection_plan,
)
from app.services.knowledge.code_wiki.publish_gate import (
    PUBLISH_GATE_EXT_KEY,
    GateVerdict,
    PublishPolicy,
    evaluate_publish_gate,
)
from app.services.knowledge.code_wiki.version_store import page_path_of
from app.services.knowledge.content_scope import generated_wiki_pages

logger = logging.getLogger(__name__)

PUBLISHED_GENERATION_KEY = "publishedGenerationId"

# Written alongside the pointer, in the same transaction, because they describe what
# that transaction just did. A list needs them and would otherwise join every wiki
# against its generations to get two fields.
PUBLISHED_AT_KEY = "lastPublishedAt"
PUBLISHED_COMMIT_KEY = "lastPublishedCommit"

# The order pages are shown in, as a list of paths. Kept here rather than on each
# document because a reorder must not touch a page whose content did not change:
# the fingerprint would still match, so the projection would skip it and the new
# position would never be written. One array, one write, no document churn.
PAGE_ORDER_KEY = "pageOrder"


@dataclass(frozen=True)
class PublishResult:
    """What a publish attempt did."""

    published: bool
    verdict: GateVerdict
    plan: Optional[ProjectionPlan] = None
    reason: str = ""


def read_version_pages(db: Session, generation_id: int) -> tuple[PageSource, ...]:
    """Read a version as the projection wants to see it.

    Entries without a page path predate page identity and are skipped rather than
    guessed at: projecting one would create a document the next run could not match,
    and so would delete and recreate on every publish.
    """
    declared = _declared_order(db, generation_id)

    ranked: list[tuple[int, int, PageSource]] = []
    for entry in (
        db.query(WikiContent).filter(WikiContent.generation_id == generation_id).all()
    ):
        path = page_path_of(entry)
        if not path:
            logger.warning(
                "[code_wiki] version entry %s has no page path; not projected",
                entry.id,
            )
            continue
        # Pages the agent did not rank sort after the ones it did, in the order they
        # were written. Alphabetical would be worse than arbitrary here: it puts "api"
        # ahead of the overview, and a wiki read in that order reads wrong.
        rank = declared.get(collation_key(path), len(declared))
        ranked.append(
            (
                rank,
                entry.id,
                PageSource(path=path, title=entry.title, content=entry.content),
            )
        )

    ranked.sort(key=lambda item: (item[0], item[1]))
    return tuple(page for _, _, page in ranked)


def _declared_order(db: Session, generation_id: int) -> dict[str, int]:
    """The page order the agent declared when it finished, keyed for matching.

    Sent as ``summary.structure_order`` and until now recorded and never read. It is
    the only statement of order there is: a path carries hierarchy but says nothing
    about which section comes first.
    """
    generation = db.get(WikiGeneration, generation_id)
    if generation is None:
        return {}
    summary = (generation.ext or {}).get("content_write", {}).get("summary", {}) or {}
    declared = summary.get("structure_order") or []
    return {
        collation_key(str(path)): index
        for index, path in enumerate(declared)
        if str(path).strip()
    }


def read_projected_pages(db: Session, kind_id: int) -> tuple[ProjectedPage, ...]:
    """Read the generated wiki pages the knowledge base currently holds.

    Scoped through ``generated_wiki_pages`` rather than by an inline filter: user
    content and code targets must never enter this comparison, because anything
    missing from the version is treated as an orphan and deleted.
    """
    query = generated_wiki_pages(
        db.query(KnowledgeDocument).filter(KnowledgeDocument.kind_id == kind_id)
    )

    pages: list[ProjectedPage] = []
    for document in query.all():
        config = document.source_config or {}
        path = config.get(PAGE_PATH_KEY)
        if not path:
            # A generated page the projection did not create. Leaving it out means it
            # is never deleted, which is the safe direction to be wrong in.
            logger.warning(
                "[code_wiki] generated document %s has no page path; left alone",
                document.id,
            )
            continue
        pages.append(
            ProjectedPage(
                document_id=document.id,
                path=path,
                content_hash=config.get(CONTENT_HASH_KEY, ""),
            )
        )
    return tuple(pages)


def published_generation_id(knowledge_base: Kind) -> int:
    spec = (knowledge_base.json or {}).get("spec", {})
    try:
        return int(spec.get(PUBLISHED_GENERATION_KEY, 0) or 0)
    except (TypeError, ValueError):
        return 0


def _update_spec(knowledge_base: Kind, **values) -> None:
    payload = dict(knowledge_base.json or {})
    spec = dict(payload.get("spec", {}))
    spec.update(values)
    payload["spec"] = spec
    knowledge_base.json = payload


def _record_verdict(generation: WikiGeneration, verdict: GateVerdict) -> None:
    ext = dict(generation.ext or {})
    ext[PUBLISH_GATE_EXT_KEY] = verdict.to_ext(
        datetime.now(timezone.utc).replace(tzinfo=None).isoformat()
    )
    generation.ext = ext


def publish_generation(
    db: Session,
    *,
    knowledge_base: Kind,
    generation: WikiGeneration,
    user_id: int,
    effects: ProjectionSideEffects,
    policy: Optional[PublishPolicy] = None,
    require_completed: bool = True,
) -> PublishResult:
    """Project a version into the knowledge base and make it the published one.

    Args:
        db: Session. Committed here once the rows are in place.
        knowledge_base: The code wiki's Kind.
        generation: Version to publish.
        user_id: Owner recorded on documents the projection creates.
        effects: Side effects outside the transaction.
        policy: Publish gate limits.
        require_completed: Whether the generation must have finished successfully.
            Set false to re-project an older version, which is what a rollback is.

    Returns:
        Whether the version was published, with the gate's verdict either way.
    """
    if require_completed and generation.status != WikiGenerationStatus.COMPLETED:
        verdict = GateVerdict(
            passed=False,
            reason=f"generation is {generation.status}, not completed",
        )
        _record_verdict(generation, verdict)
        db.commit()
        return PublishResult(published=False, verdict=verdict, reason=verdict.reason)

    # Settle what the last publish could not before computing this one. Doing it here
    # rather than on a timer keeps this function the only writer of the parked list,
    # which is what removes the race: two writers doing read-modify-write on one spec
    # key will eventually drop a ref parked between a sweep's read and its write.
    #
    # It runs before the gate on purpose. The debt has nothing to do with whether this
    # version is publishable, and a rejected version should still clear it.
    retry_pending_index_cleanup(db, knowledge_base=knowledge_base, effects=effects)

    desired = read_version_pages(db, generation.id)
    existing = read_projected_pages(db, knowledge_base.id)

    # The gate is asked what readers would lose, so it is given what readers can see
    # now — the projected pages — rather than the published version's own page list.
    # Those agree unless the knowledge base has drifted, and where they disagree the
    # projection is the one that decides what actually gets deleted.
    verdict = evaluate_publish_gate(
        desired,
        published_paths=[page.path for page in existing],
        policy=policy,
    )
    if not verdict.passed:
        logger.warning(
            "[code_wiki] generation %s rejected for kb %s: %s",
            generation.id,
            knowledge_base.id,
            verdict.reason,
        )
        _record_verdict(generation, verdict)
        db.commit()
        return PublishResult(published=False, verdict=verdict, reason=verdict.reason)

    plan = compute_projection_plan(desired, existing)
    logger.info(
        "[code_wiki] publishing generation %s into kb %s: %s",
        generation.id,
        knowledge_base.id,
        plan.describe(),
    )

    superseded = _attachments_being_replaced(db, plan)
    outcome = apply_projection_plan(
        db,
        kind_id=knowledge_base.id,
        user_id=user_id,
        plan=plan,
        effects=effects,
    )

    _record_verdict(generation, verdict)
    _update_spec(
        knowledge_base,
        **{
            PUBLISHED_GENERATION_KEY: generation.id,
            PUBLISHED_AT_KEY: datetime.now(timezone.utc)
            .replace(tzinfo=None)
            .isoformat(),
            PUBLISHED_COMMIT_KEY: str(
                (generation.source_snapshot or {}).get("commit", "") or ""
            ),
            PAGE_ORDER_KEY: [page.path for page in desired],
        },
    )
    db.commit()

    # Past this point the version is live. Nothing below may raise: the pages are
    # already correct, and failing now would only cause the run to be repeated.
    unfinished = finish_projection(
        outcome, superseded_attachment_ids=superseded, effects=effects
    )
    if unfinished:
        _park_unfinished_cleanup(db, knowledge_base, unfinished)
        db.commit()

    return PublishResult(published=True, verdict=verdict, plan=plan)


def _attachments_being_replaced(db: Session, plan: ProjectionPlan) -> tuple[int, ...]:
    """Ids of attachments the plan supersedes, read before the rows change.

    Includes each page's converted attachment: overwriting the source without it
    leaves a stale conversion that the document still points at.
    """
    touched = [update.existing.document_id for update in plan.updates]
    touched += [page.document_id for page in plan.deletes]
    if not touched:
        return ()

    doomed: list[int] = []
    # One query rather than a lookup per document. Those lookups were served from the
    # session's identity map today, because read_projected_pages had just loaded the
    # same rows — a dependency on call order that nothing states and nothing enforces.
    for document in (
        db.query(KnowledgeDocument).filter(KnowledgeDocument.id.in_(touched)).all()
    ):
        if document.attachment_id:
            doomed.append(document.attachment_id)
        converted = document.converted_attachment_id
        if converted:
            doomed.append(converted)
    return tuple(doomed)


def _park_unfinished_cleanup(
    db: Session, knowledge_base: Kind, doc_refs: Sequence[str]
) -> None:
    """Record index deletions still owed, so a sweep can finish them.

    The vector store is external and cannot be rolled into the transaction, so a
    failure has to outlive the process rather than disappear into a log line: a
    document row that is gone while its chunks remain leaves retrieval answering
    from a page that no longer exists.
    """
    # Stored as strings throughout. The retry reads them back and writes them out
    # again, so mixing in an int here would produce an entry that no longer matches
    # the membership test below and the ref would be parked twice.
    pending = [
        str(ref)
        for ref in (knowledge_base.json or {})
        .get("spec", {})
        .get(PENDING_INDEX_CLEANUP_KEY)
        or []
    ]
    pending.extend(str(ref) for ref in doc_refs if str(ref) not in pending)
    _update_spec(knowledge_base, **{PENDING_INDEX_CLEANUP_KEY: pending})
    logger.warning(
        "[code_wiki] kb %s has %s index deletions awaiting retry",
        knowledge_base.id,
        len(pending),
    )


def retry_pending_index_cleanup(
    db: Session, *, knowledge_base: Kind, effects: ProjectionSideEffects
) -> tuple[str, ...]:
    """Attempt the index deletions a previous publish could not finish.

    Called at the start of every publish rather than on a timer. The cost is that a
    wiki nobody regenerates keeps its orphaned chunks; the gain is that parking and
    draining happen in one place, so neither can overwrite the other's view of the
    list. A periodic sweeper would be a second writer of the same spec key, and the
    interleaving that loses a ref needs no unusual timing to happen.

    The debt stays visible in the meantime: it is recorded on the knowledge base and
    logged at warning level when it is parked.

    Returns:
        The refs still outstanding.
    """
    spec = (knowledge_base.json or {}).get("spec", {})
    pending = [str(ref) for ref in (spec.get(PENDING_INDEX_CLEANUP_KEY) or [])]
    if not pending:
        return ()

    still_pending: list[str] = []
    for doc_ref in pending:
        if not doc_ref.isdigit():
            # Dropped rather than retried. A ref that is not a document id can never
            # be deleted, so keeping it means every sweep from here on fails on it
            # and the list never drains.
            logger.error(
                "[code_wiki] kb %s parked an unusable index ref %r; dropping it",
                knowledge_base.id,
                doc_ref,
            )
            continue
        try:
            effects.delete_rag_document(int(doc_ref))
        except Exception as exc:
            logger.warning(
                "[code_wiki] index cleanup still failing for %s: %s", doc_ref, exc
            )
            still_pending.append(doc_ref)

    _update_spec(knowledge_base, **{PENDING_INDEX_CLEANUP_KEY: still_pending})
    db.commit()
    return tuple(still_pending)
