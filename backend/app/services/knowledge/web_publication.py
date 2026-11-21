# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Document-level publication state for web refreshes.

Candidates use the existing index generation as their physical identity. The
attachment and published pointer stay unchanged until the short publish
transaction. Old indexes are retained for in-flight reads and collected later.
"""

from __future__ import annotations

import hashlib
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.kind import Kind
from app.models.knowledge import DocumentIndexStatus, DocumentStatus, KnowledgeDocument
from app.models.subtask_context import SubtaskContext
from shared.db.capability_reference import resolve_model_kind, resolve_retriever_kind
from shared.knowledge_module.publication import publication_fingerprint

CANDIDATE_KEY = "_web_refresh"
# Gateway calls are bounded to ten minutes. Retain retired versions for a day,
# including content references, rather than deleting underneath active readers.
RETENTION_SECONDS = 24 * 60 * 60


class WebDraftExpired(ValueError):
    """A staged body must be fetched again before indexing."""


def content_hash(content: str) -> str:
    """Use the same UTF-8 body semantics at creation and every refresh entry."""
    return "sha256:" + hashlib.sha256(content.encode("utf-8")).hexdigest()


def resource_revision(db: Session, kb: Kind) -> dict:
    retrieval = (kb.json or {}).get("spec", {}).get("retrievalConfig") or {}
    embedding = retrieval.get("embedding_config") or {}
    resources = {}
    for key, resolve, name, namespace in (
        (
            "retriever",
            resolve_retriever_kind,
            retrieval.get("retriever_name"),
            retrieval.get("retriever_namespace", "default"),
        ),
        (
            "embedding",
            resolve_model_kind,
            embedding.get("model_name"),
            embedding.get("model_namespace", "default"),
        ),
    ):
        resource = resolve(db, name=name or "", namespace=namespace, user_id=kb.user_id)
        resources[key] = (
            {"id": resource.id, "hash": publication_fingerprint(resource.json)}
            if resource
            else None
        )
    return resources


def config_fingerprint(kb: Kind, document: KnowledgeDocument, db: Session) -> str:
    return publication_fingerprint(
        {
            "retrieval": (kb.json or {}).get("spec", {}).get("retrievalConfig"),
            "splitter": document.splitter_config,
            "resources": resource_revision(db, kb),
        }
    )


def attach_version_record(attachment: SubtaskContext, record: dict) -> None:
    """Persist cleanup identity with the attachment, surviving document deletion."""
    attachment.type_data = {
        **(attachment.type_data or {}),
        "lifecycle_owner": "web_refresh",
        "web_index_version": {
            **record,
            "not_before": (
                datetime.now(timezone.utc) + timedelta(seconds=RETENTION_SECONDS)
            ).isoformat(),
        },
    }


def retire_attachment(
    db: Session, attachment_id: int | None, derived_ids: list[int] | None = None
) -> None:
    if not attachment_id:
        return
    attachment = (
        db.query(SubtaskContext).filter(SubtaskContext.id == attachment_id).first()
    )
    record = (
        (attachment.type_data or {}).get("web_index_version") if attachment else None
    )
    if record:
        attach_version_record(
            attachment,
            {
                **record,
                "retired_attachments": list(
                    set(record.get("retired_attachments", []) + (derived_ids or []))
                ),
            },
        )


def candidate_for(document: KnowledgeDocument, generation: int) -> dict | None:
    candidate = (document.source_config or {}).get(CANDIDATE_KEY)
    return (
        candidate
        if isinstance(candidate, dict) and candidate.get("generation") == generation
        else None
    )


def candidate_is_running(document: KnowledgeDocument, reference: str) -> bool:
    candidate = candidate_for(document, document.index_generation)
    return bool(
        candidate
        and candidate.get("doc_ref") == reference
        and document.index_status
        in {
            DocumentIndexStatus.QUEUED,
            DocumentIndexStatus.PENDING_CONVERSION,
            DocumentIndexStatus.CONVERTING,
            DocumentIndexStatus.INDEXING,
        }
    )


def abandon_candidate(document: KnowledgeDocument, generation: int) -> bool:
    """Keep the live body and user controls; persist exact cleanup references."""
    candidate = candidate_for(document, generation)
    if candidate is None:
        return False
    config = dict(document.source_config or {})
    config.pop(CANDIDATE_KEY, None)
    if previous_draft := candidate.get("previous_draft"):
        config[CANDIDATE_KEY] = {**previous_draft, "generation": generation}
    document.source_config = config
    document.index_status = DocumentIndexStatus(candidate["previous_index_status"])
    return True


def prepare_web_reindex_candidate(
    db: Session,
    document: KnowledgeDocument,
    kb: Kind,
    *,
    generation: int,
    previous_status: DocumentIndexStatus,
    requested_by: int,
) -> int:
    """Keep explicit reindexing on the same publication contract after upgrade."""
    from app.services.context import context_service
    from app.services.rag.runtime_resolver import RagRuntimeResolver

    draft = (document.source_config or {}).get(CANDIDATE_KEY) or {}
    use_draft = (
        draft.get("draft") is True
        and draft.get("url") == (document.source_config or {}).get("url")
        and draft.get("config_fingerprint") == config_fingerprint(kb, document, db)
    )
    attachment_id = draft.get("attachment_id") if use_draft else document.attachment_id
    attachment = db.get(SubtaskContext, attachment_id) if attachment_id else None
    if use_draft:
        record = (
            (attachment.type_data or {}).get("web_index_version")
            if attachment
            else None
        )
        if (
            draft.get("expired")
            or record is None
            or datetime.fromisoformat(record["not_before"])
            <= datetime.now(timezone.utc)
        ):
            raise WebDraftExpired(
                "Staged web body has expired; refresh the page before indexing"
            )
    body = (
        context_service.get_attachment_binary_data(db, attachment)
        if attachment
        else None
    )
    if not body:
        raise ValueError("Published web body is unavailable")
    candidate_attachment, _ = context_service.upload_attachment(
        db=db,
        user_id=document.user_id,
        filename=f"{document.id}.md",
        binary_data=body,
        subtask_id=0,
        lifecycle_owner="web_refresh",
        commit=False,
    )
    reference = f"{document.id}@{generation}"
    delete_spec = (
        RagRuntimeResolver()
        .build_delete_runtime_spec(
            db=db,
            knowledge_base_id=kb.id,
            document_ref=reference,
            index_owner_user_id=kb.user_id,
        )
        .model_dump(mode="json")
    )
    attach_version_record(
        candidate_attachment,
        {
            "document_id": document.id,
            "doc_ref": reference,
            "delete_spec": delete_spec,
            "retriever_revision": resource_revision(db, kb)["retriever"],
        },
    )
    config = dict(document.source_config or {})
    config[CANDIDATE_KEY] = {
        "generation": generation,
        "user_state": {"is_active": document.is_active, "status": document.status},
        "user_status_override": config.get("web_user_status"),
        "doc_ref": reference,
        "url": config.get("url"),
        "automatic": False,
        "requested_by": requested_by,
        "config_fingerprint": config_fingerprint(kb, document, db),
        "previous_index_status": getattr(previous_status, "value", previous_status)
        or "not_indexed",
        "attachment_id": candidate_attachment.id,
        "file_size": len(body),
        "content_hash": content_hash(body.decode("utf-8")),
        "metadata": draft.get("metadata", {}) if use_draft else {},
        "body_unchanged": not use_draft
        or draft.get("content_hash")
        == config.get("webAutoUpdate", {}).get("content_hash"),
        "delete_spec": delete_spec,
        **({"previous_draft": draft} if use_draft else {}),
    }
    document.source_config = config
    db.commit()
    return candidate_attachment.id


def _requester_can_publish(
    db: Session, kb: Kind, document: KnowledgeDocument, candidate: dict
) -> bool:
    from app.models.user import User
    from app.services.knowledge.knowledge_service import KnowledgeService

    requester_id = candidate.get("requested_by")
    if requester_id is None:
        return False
    requester = (
        db.query(User).filter(User.id == requester_id, User.is_active.is_(True)).first()
    )
    if requester is None:
        return False
    try:
        KnowledgeService._assert_can_manage_document(db, kb, document, requester_id)
    except ValueError:
        return False
    return True


def publish_candidate(
    db: Session,
    *,
    document_id: int,
    generation: int,
    chunks: dict | None,
    lease: Any,
) -> bool:
    """Validate fencing and switch body, derived content and pointer together."""
    document = (
        db.query(KnowledgeDocument)
        .filter(KnowledgeDocument.id == document_id)
        .populate_existing()
        .with_for_update()
        .first()
    )
    if document is None or document.index_generation != generation:
        db.rollback()
        return False
    config = dict(document.source_config or {})
    if config.get("published_generation") == generation:
        db.rollback()
        return True
    if lease is None or not lease.owned():
        db.rollback()
        return False
    candidate = candidate_for(document, generation)
    if candidate is None or not candidate.get("attachment_id"):
        db.rollback()
        return False
    kb = (
        db.query(Kind)
        .filter(
            Kind.id == document.kind_id,
            Kind.kind == "KnowledgeBase",
            Kind.is_active.is_(True),
        )
        .populate_existing()
        .with_for_update()
        .first()
    )
    valid = (
        kb is not None
        and document.index_status == DocumentIndexStatus.INDEXING
        and candidate.get("user_state", {"is_active": True, "status": "enabled"})
        == {"is_active": document.is_active, "status": document.status}
        and candidate.get("user_status_override") == config.get("web_user_status")
        and document.source_type == "web"
        and document.origin == "user"
        and config.get("url") == candidate["url"]
        and config_fingerprint(kb, document, db) == candidate["config_fingerprint"]
        and (
            not candidate["automatic"]
            or (
                settings.WEB_AUTO_UPDATE_SCHEDULE_ENABLED
                and (kb.json or {}).get("spec", {}).get("webAutoUpdateEnabled") is True
            )
        )
        and _requester_can_publish(db, kb, document, candidate)
        and lease is not None
        and lease.owned()
    )
    if not valid:
        abandon_candidate(document, generation)
        db.commit()
        return False
    if (
        not document.is_active
        and not config.get("published_generation")
        and candidate["previous_index_status"] in {"not_indexed", "failed"}
    ):
        # A first index becomes ready independently of the user's status switch.
        document.is_active = True
        document.status = DocumentStatus(config.get("web_user_status") or "enabled")
    body_changed = not candidate.get("body_unchanged") and candidate[
        "content_hash"
    ] != config.get("webAutoUpdate", {}).get("content_hash")
    retire_attachment(
        db,
        document.attachment_id,
        [
            config[key]
            for key in (
                ("converted_attachment_id", "summary_attachment_id")
                if body_changed
                else ()
            )
            if isinstance(config.get(key), int) and config[key] > 0
        ],
    )
    document.attachment_id = candidate["attachment_id"]
    document.file_extension = "md"
    document.file_size = candidate["file_size"]
    document.chunks = (
        chunks
        if settings.CHUNK_STORAGE_ENABLED
        else (
            {
                key: chunks[key]
                for key in ("splitter_subtype", "qa_pair_count")
                if key in chunks
            }
            if chunks
            else None
        )
    )
    if body_changed:
        document.summary = None
    # Derived content belongs to the replaced body. Summary can be regenerated
    # after commit when explicitly requested by the caller.
    for key in (
        ("converted_attachment_id", "summary", "summary_attachment_id")
        if body_changed
        else ()
    ):
        config.pop(key, None)
    config.update(candidate["metadata"])
    config["published_generation"] = generation
    config["published_index_fingerprint"] = candidate["config_fingerprint"]
    config["webAutoUpdate"] = {
        **config.get("webAutoUpdate", {}),
        "content_hash": candidate["content_hash"],
    }
    config["webAutoUpdate"].pop("last_error_code", None)
    config.pop(CANDIDATE_KEY, None)
    document.source_config = config
    document.index_status = DocumentIndexStatus.SUCCESS
    document.clear_processing_error_payload()
    # Replacement publications preserve current controls; only first indexing
    # transitions a system-created, not-yet-ready document into a usable state.
    db.commit()
    return True
