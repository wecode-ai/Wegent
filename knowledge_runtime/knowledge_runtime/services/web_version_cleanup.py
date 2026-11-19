# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Resolve an exact retired version from its persisted attachment record."""

from datetime import datetime, timezone

from knowledge_runtime.models.knowledge_document import KnowledgeDocument
from knowledge_runtime.services.config_resolver import (
    AdminResolvedConfig,
    ConfigResolutionError,
)
from shared.db.capability_reference import resolve_retriever_kind
from shared.knowledge_module.publication import publication_fingerprint
from shared.models.db.subtask_context import SubtaskContext


def resolve_retired_config(db, resolver, request) -> AdminResolvedConfig:
    attachment_id = (request.extensions or {}).get("version_attachment_id")
    attachment = (
        db.query(SubtaskContext).filter(SubtaskContext.id == attachment_id).first()
    )
    record = (
        (attachment.type_data or {}).get("web_index_version") if attachment else None
    )
    authorized = request.authorized_resources
    if record is None or authorized is None:
        raise ConfigResolutionError(
            "authorization_mismatch", "Retired version record not found"
        )
    stored = record["delete_spec"]
    if (
        record["doc_ref"] != request.document_ref
        or stored["knowledge_base_id"] != request.knowledge_base_id
        or stored["authorized_resources"] != authorized.model_dump(mode="json")
        or stored["index_owner_user_id"] != request.user_id
        or datetime.fromisoformat(record["not_before"]) > datetime.now(timezone.utc)
    ):
        raise ConfigResolutionError(
            "authorization_mismatch", "Version cleanup identity mismatch"
        )
    document = (
        db.query(KnowledgeDocument)
        .filter(KnowledgeDocument.id == record["document_id"])
        .first()
    )
    if document is not None:
        config = document.source_config or {}
        generation = config.get("published_generation")
        published = f"{document.id}@{generation}" if generation else str(document.id)
        candidate = config.get("_web_refresh") or {}
        active_candidate = (
            candidate.get("generation") == document.index_generation
            and document.index_status
            in {"queued", "pending_conversion", "converting", "indexing"}
            and candidate.get("doc_ref") == request.document_ref
        )
        if request.document_ref == published or active_candidate:
            raise ConfigResolutionError(
                "authorization_mismatch", "Version is still referenced"
            )
    ref = authorized.retriever
    retriever = resolve_retriever_kind(
        db,
        name=ref.name,
        namespace=ref.namespace,
        user_id=authorized.index_owner_user_id,
    )
    revision = (
        {"id": retriever.id, "hash": publication_fingerprint(retriever.json)}
        if retriever
        else None
    )
    if revision != record.get("retriever_revision") or retriever is None:
        raise ConfigResolutionError(
            "config_invalid", "Original version storage has changed; cleanup retained"
        )
    return AdminResolvedConfig(
        index_owner_user_id=authorized.index_owner_user_id,
        retriever_config=resolver._build_retriever_config_from_kind(
            retriever, name=ref.name, namespace=ref.namespace
        ),
    )
