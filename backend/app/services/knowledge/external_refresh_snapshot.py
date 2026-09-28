# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Persist the rollback state of one synchronized external refresh."""

from __future__ import annotations

from typing import Any

from app.models.knowledge import DocumentIndexStatus, DocumentStatus, KnowledgeDocument

EXTERNAL_REFRESH_SNAPSHOT_KEY = "_pending_external_refresh"


def get_external_refresh_snapshot(
    document: KnowledgeDocument,
    generation: int | None = None,
) -> dict[str, Any] | None:
    """Return the active refresh snapshot when its generation matches."""
    value = (document.source_config or {}).get(EXTERNAL_REFRESH_SNAPSHOT_KEY)
    if not isinstance(value, dict):
        return None
    snapshot = dict(value)
    if generation is not None and snapshot.get("generation") != generation:
        return None
    return snapshot


def capture_external_refresh_snapshot(
    document: KnowledgeDocument,
    *,
    generation: int,
    previous_index_status: DocumentIndexStatus,
) -> None:
    """Capture state that must survive external fetch and indexing workers."""
    source_config = dict(document.source_config or {})
    external = document.external_source_config
    sync = external.get("sync")
    sync = dict(sync) if isinstance(sync, dict) else {}
    source_config[EXTERNAL_REFRESH_SNAPSHOT_KEY] = {
        "generation": generation,
        "previous_index_status": previous_index_status.value,
        "previous_is_active": bool(document.is_active),
        "previous_document_status": document.status.value,
        "previous_attachment_id": int(document.attachment_id or 0),
        "previous_converted_attachment_id": document.converted_attachment_id,
        "previous_file_extension": document.file_extension,
        "previous_file_size": int(document.file_size or 0),
        "previous_processing_error": document.processing_error_payload,
        "had_content_version": "content_version" in sync,
        "previous_content_version": sync.get("content_version"),
        "had_source_update_time": "source_update_time" in external,
        "previous_source_update_time": external.get("source_update_time"),
    }
    document.source_config = source_config


def advance_external_refresh_snapshot(
    document: KnowledgeDocument,
    *,
    expected_generation: int,
    next_generation: int,
) -> None:
    """Move a prepared snapshot to the generation claimed by the import worker."""
    snapshot = get_external_refresh_snapshot(document, expected_generation)
    if snapshot is None:
        return
    snapshot["generation"] = next_generation
    _store_snapshot(document, snapshot)


def stage_external_refresh_attachment(
    source_config: dict[str, Any],
    *,
    generation: int,
    attachment_id: int,
) -> bool:
    """Record the candidate body in a source-config copy before guarded landing."""
    value = source_config.get(EXTERNAL_REFRESH_SNAPSHOT_KEY)
    if not isinstance(value, dict) or value.get("generation") != generation:
        return False
    snapshot = dict(value)
    snapshot["staged_attachment_id"] = attachment_id
    source_config[EXTERNAL_REFRESH_SNAPSHOT_KEY] = snapshot
    return True


def restore_external_refresh_snapshot(
    document: KnowledgeDocument,
    *,
    generation: int,
) -> set[int] | None:
    """Restore the pre-refresh body and return staged attachments to reap."""
    snapshot = get_external_refresh_snapshot(document, generation)
    if snapshot is None:
        return None

    current_attachment_id = int(document.attachment_id or 0)
    current_converted_id = document.converted_attachment_id
    staged_attachment_id = int(snapshot.get("staged_attachment_id") or 0)
    previous_attachment_id = int(snapshot.get("previous_attachment_id") or 0)
    previous_converted_id = snapshot.get("previous_converted_attachment_id")
    previous_converted_id = (
        int(previous_converted_id) if previous_converted_id is not None else None
    )

    source_config = dict(document.source_config or {})
    source_config.pop(EXTERNAL_REFRESH_SNAPSHOT_KEY, None)
    if previous_converted_id is None:
        source_config.pop("converted_attachment_id", None)
    else:
        source_config["converted_attachment_id"] = previous_converted_id

    previous_error = snapshot.get("previous_processing_error")
    if isinstance(previous_error, dict):
        source_config["processing_error"] = dict(previous_error)
    else:
        source_config.pop("processing_error", None)

    external = dict(source_config.get("external") or {})
    sync = external.get("sync")
    if isinstance(sync, dict):
        sync = dict(sync)
        if snapshot.get("had_content_version"):
            sync["content_version"] = snapshot.get("previous_content_version")
        else:
            sync.pop("content_version", None)
        external["sync"] = sync
    if snapshot.get("had_source_update_time"):
        external["source_update_time"] = snapshot.get("previous_source_update_time")
    else:
        external.pop("source_update_time", None)
    source_config["external"] = external

    document.source_config = source_config
    document.attachment_id = previous_attachment_id
    document.file_extension = str(
        snapshot.get("previous_file_extension") or document.file_extension
    )
    document.file_size = int(snapshot.get("previous_file_size") or 0)
    document.is_active = bool(snapshot.get("previous_is_active"))
    document.index_status = _index_status(
        snapshot.get("previous_index_status"), DocumentIndexStatus.FAILED
    )
    document.status = _document_status(
        snapshot.get("previous_document_status"), document.status
    )

    retained_ids = {previous_attachment_id, previous_converted_id or 0}
    return {
        attachment_id
        for attachment_id in {
            current_attachment_id,
            current_converted_id or 0,
            staged_attachment_id,
        }
        if attachment_id and attachment_id not in retained_ids
    }


def finalize_external_refresh_snapshot(
    document: KnowledgeDocument,
    *,
    generation: int,
) -> set[int] | None:
    """Clear a successful snapshot and return superseded attachments to reap."""
    snapshot = get_external_refresh_snapshot(document, generation)
    if snapshot is None:
        return None
    source_config = dict(document.source_config or {})
    source_config.pop(EXTERNAL_REFRESH_SNAPSHOT_KEY, None)
    document.source_config = source_config
    current_ids = {
        int(document.attachment_id or 0),
        int(document.converted_attachment_id or 0),
    }
    return {
        int(attachment_id)
        for attachment_id in {
            snapshot.get("previous_attachment_id"),
            snapshot.get("previous_converted_attachment_id"),
        }
        if attachment_id and int(attachment_id) not in current_ids
    }


def _store_snapshot(document: KnowledgeDocument, snapshot: dict[str, Any]) -> None:
    source_config = dict(document.source_config or {})
    source_config[EXTERNAL_REFRESH_SNAPSHOT_KEY] = snapshot
    document.source_config = source_config


def _index_status(value: object, fallback: DocumentIndexStatus) -> DocumentIndexStatus:
    try:
        return DocumentIndexStatus(str(value))
    except ValueError:
        return fallback


def _document_status(value: object, fallback: DocumentStatus) -> DocumentStatus:
    try:
        return DocumentStatus(str(value))
    except ValueError:
        return fallback
