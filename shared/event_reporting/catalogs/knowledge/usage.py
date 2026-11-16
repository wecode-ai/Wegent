# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Content-free business usage facts from already selected knowledge results."""

from __future__ import annotations

from collections.abc import Iterable

from ...reporter import is_event_reporting_enabled
from ._common import loaded_scalar, observe

METRIC_DEFINITION_VERSION = "usage-v1"


def _organization_fields(org_id: str | None, org_version: str | None) -> dict[str, str]:
    result = {}
    if org_id is not None:
        result["actor_org_id"] = org_id
    if org_version is not None:
        result["actor_org_version"] = org_version
    return result


def _identity(value: object) -> int | str | None:
    """Keep only bounded scalar identities accepted by the event contract."""
    if type(value) is int:
        return value if value.bit_length() <= 64 else None
    if isinstance(value, str):
        return value if len(value) <= 256 else None
    return None


def report_kb_usage(
    *,
    invocation_id: str,
    kb_ids: Iterable[int],
    actor_user_id: int | None,
    actor_type: str,
    entrypoint: str,
    client_surface: str,
    task_id: int | None = None,
    subtask_id: int | None = None,
    actor_org_id: str | None = None,
    actor_org_version: str | None = None,
) -> None:
    """Emit one successful logical invocation fact per unique knowledge base."""
    if not is_event_reporting_enabled("knowledge.usage.kb.recorded"):
        return
    unique_kb_ids: list[int] = []
    try:
        for raw_kb_id in kb_ids:
            kb_id = _identity(raw_kb_id)
            if type(kb_id) is int and kb_id not in unique_kb_ids:
                unique_kb_ids.append(kb_id)
    except Exception:
        return
    for kb_id in unique_kb_ids:
        observe(
            "knowledge.usage.kb.recorded",
            lambda kb_id=kb_id: {
                "kb_id": kb_id,
                "status": "success",
                "fact_key_parts": (invocation_id, kb_id, "invoked"),
                "data": {
                    "invocation_id": invocation_id,
                    "actor_user_id": actor_user_id,
                    "actor_type": actor_type,
                    "entrypoint": entrypoint,
                    "client_surface": client_surface,
                    "task_id": task_id,
                    "subtask_id": subtask_id,
                    "usage_stage": "invoked",
                    "metric_definition_version": METRIC_DEFINITION_VERSION,
                    **_organization_fields(actor_org_id, actor_org_version),
                },
            },
        )


def report_document_usage(
    records: Iterable[object],
    *,
    invocation_id: str,
    actor_user_id: int | None,
    actor_type: str,
    entrypoint: str,
    client_surface: str,
    task_id: int | None = None,
    subtask_id: int | None = None,
    usage_stage: str = "context_delivery",
    actor_org_id: str | None = None,
    actor_org_version: str | None = None,
) -> None:
    """Emit one fact for each unique document already selected for delivery."""
    if not is_event_reporting_enabled("knowledge.usage.document.recorded"):
        return
    identities: set[tuple[int | str, int | str]] = set()
    unidentified_record_count = 0
    try:
        for record in records:
            kb_id = _identity(loaded_scalar(record, "knowledge_base_id"))
            document_id = _identity(loaded_scalar(record, "document_id"))
            if document_id is None:
                document_id = _identity(
                    loaded_scalar(loaded_scalar(record, "metadata"), "document_id")
                )
            if kb_id is not None and document_id is not None:
                identities.add((kb_id, document_id))
            else:
                unidentified_record_count += 1
    except Exception:
        return

    expected_document_count = len(identities)
    coverage_state = "complete" if unidentified_record_count == 0 else "partial"
    for kb_id, document_id in sorted(identities, key=lambda value: str(value)):
        observe(
            "knowledge.usage.document.recorded",
            lambda kb_id=kb_id, document_id=document_id: {
                "kb_id": kb_id,
                "document_id": document_id,
                "status": "success",
                "fact_key_parts": (
                    invocation_id,
                    kb_id,
                    document_id,
                    usage_stage,
                ),
                "data": {
                    "invocation_id": invocation_id,
                    "actor_user_id": actor_user_id,
                    "actor_type": actor_type,
                    "entrypoint": entrypoint,
                    "client_surface": client_surface,
                    "task_id": task_id,
                    "subtask_id": subtask_id,
                    "usage_stage": usage_stage,
                    "expected_document_count": expected_document_count,
                    "coverage_state": coverage_state,
                    "metric_definition_version": METRIC_DEFINITION_VERSION,
                    **_organization_fields(actor_org_id, actor_org_version),
                },
            },
        )
