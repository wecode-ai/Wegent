# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Web-specific preparation around the existing document index state machine."""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone
from urllib.parse import urlsplit

from sqlalchemy.orm import Session

from app.core.distributed_lock import distributed_lock
from app.models.kind import Kind
from app.models.knowledge import DocumentIndexStatus, KnowledgeDocument
from app.models.user import User
from app.schemas.knowledge import KnowledgeDocumentResponse
from app.services.knowledge.index_state_machine import (
    get_document_index_lock_name,
    prepare_document_index_enqueue,
)
from app.services.knowledge.knowledge_service import KnowledgeService
from app.services.knowledge.web_publication import (
    CANDIDATE_KEY,
    abandon_candidate,
    attach_version_record,
    attachment_exists,
    candidate_for,
    candidate_is_running,
    config_fingerprint,
    content_hash,
    load_owned_attachment,
    resource_revision,
)
from shared.telemetry.decorators import trace_async

logger = logging.getLogger(__name__)


class WebRefreshBusy(RuntimeError):
    """An existing owner is still fetching or indexing this document/domain."""

    generation: int | None = None


class WebRefreshDomainBusy(WebRefreshBusy):
    """A different document is using the shared fetch allowance."""


class WebRefreshInvalid(ValueError):
    def __init__(self, code: str, message: str) -> None:
        self.code = code
        super().__init__(message)


def response(
    document: KnowledgeDocument | None = None,
    code: str | None = None,
    message: str | None = None,
) -> dict:
    return {
        "success": code is None,
        "document": (
            KnowledgeDocumentResponse.model_validate(document)
            if document is not None
            else None
        ),
        "error_code": code,
        "error_message": message,
    }


async def scrape_with_domain_lease(url: str):
    """One shared-domain lease per origin, including redirect/frame origins."""
    from contextlib import ExitStack

    from app.services.web_scraper import WebScraperService
    from app.services.web_scraper.security import fetch_domain_admission

    leases, failures = {}, []
    admission_lock = asyncio.Lock()
    with ExitStack() as stack:

        async def admit_locked(target: str) -> None:
            host = (urlsplit(target).hostname or "").lower()
            if not host or host in leases:
                return
            lease = stack.enter_context(
                distributed_lock.owned_watchdog_context(f"web-fetch:{host}")
            )
            if lease is None:
                error = WebRefreshDomainBusy(
                    "A fetch for this domain is already running"
                )
                raise error
            leases[host] = lease
            redis = distributed_lock.redis_client
            seconds, micros = redis.time()
            now = seconds + micros / 1_000_000
            key = f"wegent:web-fetch:last-start:{host}"
            delay = max(0, float(redis.get(key) or 0) + 5 - now)
            if delay:
                await asyncio.sleep(delay)
            if not lease.owned():
                raise WebRefreshDomainBusy("Domain lease was lost")
            seconds, micros = redis.time()
            redis.set(key, seconds + micros / 1_000_000, ex=86400)

        async def admit(target: str) -> None:
            try:
                # Redirects and frames may be requested concurrently by a page.
                async with admission_lock:
                    await admit_locked(target)
            except Exception as exc:
                failures.append(exc)
                raise

        token = fetch_domain_admission.set(admit)
        try:
            await admit(url)
            # Celery deliveries each use a new event loop. Close the
            # browser transport on the loop that created it.
            scraper = WebScraperService()
            try:
                result = await scraper.scrape_url(url, allow_short_content=True)
            finally:
                try:
                    await scraper.close()
                except Exception:
                    logger.warning("Could not close web refresh browser", exc_info=True)
            if failures:
                raise failures[0]
            if any(not lease.owned() for lease in leases.values()):
                raise WebRefreshDomainBusy("Domain lease was lost")
            return result
        finally:
            fetch_domain_admission.reset(token)


def _context(db: Session, document_id: int, user: User, automatic: bool):
    document = KnowledgeService.get_document(
        db=db, document_id=document_id, user_id=user.id
    )
    if document is None:
        raise WebRefreshInvalid("NOT_FOUND", "Document not found or access denied")
    if document.source_type != "web":
        raise WebRefreshInvalid("INVALID_TYPE", "Document is not a web document")
    kb = (
        db.query(Kind)
        .filter(
            Kind.id == document.kind_id,
            Kind.kind == "KnowledgeBase",
            Kind.is_active.is_(True),
        )
        .first()
    )
    if kb is None:
        raise WebRefreshInvalid("KB_NOT_FOUND", "Knowledge base not found")
    KnowledgeService._assert_can_manage_document(db, kb, document, user.id)
    from app.services.knowledge.content_scope import assert_user_content_is_mutable

    assert_user_content_is_mutable(getattr(document, "origin", "user"))
    if automatic and (not document.is_active or document.status != "enabled"):
        raise ValueError("Document is disabled")
    if (
        automatic
        and (kb.json or {}).get("spec", {}).get("webAutoUpdateEnabled") is not True
    ):
        raise ValueError("Web auto update is disabled")
    if not (document.source_config or {}).get("url"):
        raise WebRefreshInvalid("NO_URL", "Document has no source URL")
    return document, kb


async def _refresh_unindexed_body(
    db: Session, user: User, document: KnowledgeDocument, kb: Kind, lease
) -> dict:
    """Preserve pre-index editing without requiring a retrieval configuration."""
    from app.services.context import context_service
    from app.services.knowledge.attachment_cleanup import delete_attachment_best_effort

    doc_id, generation = document.id, document.index_generation
    initial_index_status = document.index_status
    url = document.source_config["url"]
    fingerprint = config_fingerprint(kb, document, db)
    user_state = (document.is_active, document.status)
    db.rollback()
    result = await scrape_with_domain_lease(url)
    if not result.success or not result.content.strip():
        raise WebRefreshInvalid(
            result.error_code or "EMPTY_CONTENT",
            result.error_message or "The page has no valid content",
        )
    db.query(KnowledgeDocument).filter(
        KnowledgeDocument.id == doc_id
    ).populate_existing().with_for_update().first()
    document, kb = _context(db, doc_id, user, False)
    if (
        document.index_generation != generation
        or document.index_status != initial_index_status
        or document.source_config.get("url") != url
        or config_fingerprint(kb, document, db) != fingerprint
        or (document.is_active, document.status) != user_state
        or not lease.owned()
    ):
        raise WebRefreshInvalid("REFRESH_SUPERSEDED", "Refresh was superseded")
    old_body = load_owned_attachment(db, document.attachment_id, document.user_id)
    old_id = old_body.id if old_body is not None else None
    attachment, _ = context_service.upload_attachment(
        db=db,
        user_id=document.user_id,
        filename=f"{doc_id}.md",
        binary_data=result.content.encode("utf-8"),
        subtask_id=0,
        commit=False,
    )
    document.attachment_id = attachment.id
    document.file_size, document.file_extension = (
        len(result.content.encode("utf-8")),
        "md",
    )
    document.index_generation += 1
    document.chunks, document.summary = None, None
    config = dict(document.source_config or {})
    for key in ("converted_attachment_id", "summary", "summary_attachment_id"):
        config.pop(key, None)
    config.update(
        {
            "title": result.title,
            "description": result.description,
            "scraped_at": result.scraped_at.isoformat(),
            "webAutoUpdate": {
                "content_hash": content_hash(result.content),
                "last_checked_at": datetime.now(timezone.utc).isoformat(),
            },
        }
    )
    document.source_config = config
    db.commit()
    if old_id:
        delete_attachment_best_effort(
            db, document.user_id, old_id, preserve_referenced=True
        )
    return response(document)


@trace_async(span_name="knowledge.web_refresh", tracer_name="backend.services")
async def refresh_web_document(
    db: Session,
    user: User,
    document_id: int,
    *,
    trigger_indexing: bool = True,
    trigger_summary: bool = False,
    automatic: bool = False,
    expected_generation: int | None = None,
) -> dict:
    """Fetch an immutable candidate; hand off to the existing Celery index task."""
    from app.services.context import context_service
    from app.services.knowledge.indexing import runtime_resolver
    from app.tasks.knowledge_tasks import index_document_task

    with distributed_lock.owned_watchdog_context(
        get_document_index_lock_name(document_id)
    ) as lease:
        if lease is None:
            raise WebRefreshBusy("The document is already being refreshed")
        document, kb = _context(db, document_id, user, automatic)
        doc_id, kb_id, owner_id = document.id, kb.id, kb.user_id
        url = document.source_config["url"]
        fingerprint = config_fingerprint(kb, document, db)
        retrieval = (kb.json or {}).get("spec", {}).get("retrievalConfig") or {}
        if (
            not automatic
            and not (document.source_config or {}).get("published_generation")
            and (
                document.index_status == DocumentIndexStatus.NOT_INDEXED
                or (
                    document.index_status == DocumentIndexStatus.FAILED
                    and not document.is_active
                )
            )
            and (
                not trigger_indexing
                or not retrieval.get("retriever_name")
                or not retrieval.get("embedding_config", {}).get("model_name")
            )
        ):
            return await _refresh_unindexed_body(db, user, document, kb, lease)
        if not retrieval.get("retriever_name") or not retrieval.get(
            "embedding_config", {}
        ).get("model_name"):
            return response(
                code="INDEX_CONFIG_REQUIRED",
                message="Configure retrieval before refreshing",
            )
        # Resolve resources before advancing the state machine: configuration
        # errors must not strand a queued document without a candidate.
        delete_spec = runtime_resolver.build_delete_runtime_spec(
            db=db,
            knowledge_base_id=kb_id,
            document_ref=str(doc_id),
            index_owner_user_id=owner_id,
        )
        revision = resource_revision(db, kb)["retriever"]
        decision = prepare_document_index_enqueue(
            db, doc_id, allow_if_success=True, expected_generation=expected_generation
        )
        if not decision.should_enqueue:
            return response(code="REFRESH_BUSY", message=decision.reason)
        generation = decision.generation
        db.refresh(document)
        previous_draft = (document.source_config or {}).get(CANDIDATE_KEY) or {}
        candidate = {
            **(
                {"previous_draft": previous_draft}
                if previous_draft.get("draft")
                else {}
            ),
            "generation": generation,
            "url": url,
            "automatic": automatic,
            "requested_by": user.id,
            "config_fingerprint": fingerprint,
            "previous_index_status": getattr(
                decision.previous_status, "value", decision.previous_status
            )
            or "not_indexed",
            "doc_ref": f"{doc_id}@{generation}",
            "user_state": {"is_active": document.is_active, "status": document.status},
            "user_status_override": (document.source_config or {}).get(
                "web_user_status"
            ),
        }
        candidate["delete_spec"] = {
            **delete_spec.model_dump(mode="json"),
            "document_ref": candidate["doc_ref"],
        }
        state = dict(document.source_config or {})
        state[CANDIDATE_KEY] = candidate
        document.source_config = state
        db.commit()
        try:
            result = await scrape_with_domain_lease(url)
            if not result.success or not result.content.strip():
                raise WebRefreshInvalid(
                    result.error_code or "EMPTY_CONTENT",
                    result.error_message or "The page has no valid content",
                )
            digest = content_hash(result.content)
            # No hash baseline is not evidence of equality: safely build once.
            db.rollback()
            # Lock and reload before either completion path can change state.
            db.query(KnowledgeDocument).filter(
                KnowledgeDocument.id == doc_id
            ).populate_existing().with_for_update().first()
            document, kb = _context(db, doc_id, user, automatic)
            if (
                document.index_generation != generation
                or document.index_status != DocumentIndexStatus.QUEUED
                or candidate_for(document, generation) is None
                or config_fingerprint(kb, document, db) != fingerprint
                or document.source_config.get("url") != url
                or candidate["user_state"]
                != {"is_active": document.is_active, "status": document.status}
                or candidate.get("user_status_override")
                != document.source_config.get("web_user_status")
                or not lease.owned()
            ):
                raise ValueError("Refresh was superseded")
            state = dict(document.source_config or {})
            state["webAutoUpdate"] = {
                **state.get("webAutoUpdate", {}),
                "last_checked_at": datetime.now(timezone.utc).isoformat(),
            }
            if (
                state["webAutoUpdate"].get("content_hash") == digest
                and state.get("published_index_fingerprint") == fingerprint
                and candidate["previous_index_status"] == "success"
                and (
                    not state.get("published_generation")
                    or attachment_exists(db, document.attachment_id)
                )
            ):
                state["webAutoUpdate"].pop("last_error_code", None)
                state.pop(CANDIDATE_KEY, None)
                if previous_draft.get("draft") and (
                    automatic or previous_draft.get("content_hash") == digest
                ):
                    state[CANDIDATE_KEY] = {**previous_draft, "generation": generation}
                updated = (
                    db.query(KnowledgeDocument)
                    .filter(
                        KnowledgeDocument.id == doc_id,
                        KnowledgeDocument.index_generation == generation,
                        KnowledgeDocument.index_status == DocumentIndexStatus.QUEUED,
                    )
                    .update(
                        {
                            KnowledgeDocument.source_config: state,
                            KnowledgeDocument.index_status: DocumentIndexStatus.SUCCESS,
                        },
                        synchronize_session=False,
                    )
                )
                if updated != 1 or not lease.owned():
                    raise ValueError("Refresh was superseded")
                db.commit()
                db.refresh(document)
                return response(document)
            # Candidate attachment and its durable reference share a transaction.
            attachment, _ = context_service.upload_attachment(
                db=db,
                user_id=document.user_id,
                filename=f"{doc_id}.md",
                binary_data=result.content.encode("utf-8"),
                subtask_id=0,
                lifecycle_owner="web_refresh",
                commit=False,
            )
            attachment_id = attachment.id
            attach_version_record(
                attachment,
                {
                    "document_id": doc_id,
                    "delete_spec": candidate["delete_spec"],
                    "retriever_revision": revision,
                    "doc_ref": candidate["doc_ref"],
                },
            )
            candidate.update(
                {
                    "attachment_id": attachment_id,
                    "file_size": len(result.content.encode("utf-8")),
                    "content_hash": digest,
                    "metadata": {
                        "title": result.title,
                        "description": result.description,
                        "scraped_at": result.scraped_at.isoformat(),
                    },
                }
            )
            state = dict(document.source_config or {})
            state[CANDIDATE_KEY] = candidate
            state["webAutoUpdate"] = {
                **state.get("webAutoUpdate", {}),
                "last_checked_at": datetime.now(timezone.utc).isoformat(),
            }
            document.source_config = state
            if not trigger_indexing:
                # Preparing a draft never changes the body paired with a live index.
                document.index_status = decision.previous_status
                candidate.pop("previous_draft", None)
                candidate["draft"] = True
                document.source_config = {
                    **document.source_config,
                    CANDIDATE_KEY: candidate,
                }
            db.commit()
            if trigger_indexing:
                embedding = retrieval["embedding_config"]
                index_document_task.apply_async(
                    kwargs={
                        "knowledge_base_id": str(kb_id),
                        "attachment_id": attachment_id,
                        "retriever_name": retrieval["retriever_name"],
                        "retriever_namespace": retrieval.get(
                            "retriever_namespace", "default"
                        ),
                        "embedding_model_name": embedding["model_name"],
                        "embedding_model_namespace": embedding.get(
                            "model_namespace", "default"
                        ),
                        "user_id": owner_id,
                        "user_name": user.user_name,
                        "caller_user_id": None if automatic else user.id,
                        "document_id": doc_id,
                        "index_generation": generation,
                        "publication_generation": generation,
                        "trigger_summary": trigger_summary,
                        "trigger": "web_refresh",
                    },
                    queue="wegent_online",
                )
            db.refresh(document)
            return response(document)
        except Exception as exc:
            if isinstance(exc, WebRefreshBusy):
                exc.generation = generation
            db.rollback()
            document = (
                db.query(KnowledgeDocument)
                .filter(KnowledgeDocument.id == doc_id)
                .populate_existing()
                .with_for_update()
                .first()
            )
            if (
                document is not None
                and candidate_is_running(document, candidate["doc_ref"])
                and lease.owned()
            ):
                abandon_candidate(document, generation)
                state = dict(document.source_config or {})
                state["webAutoUpdate"] = {
                    **state.get("webAutoUpdate", {}),
                    "last_checked_at": datetime.now(timezone.utc).isoformat(),
                    "last_error_code": (
                        exc.code
                        if isinstance(exc, WebRefreshInvalid)
                        else (
                            "refresh_busy"
                            if isinstance(exc, WebRefreshBusy)
                            else "refresh_failed"
                        )
                    ),
                }
                document.source_config = state
                db.commit()
            else:
                db.rollback()
            raise
