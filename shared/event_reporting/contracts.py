# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Bounded, content-free wire contracts. No business enrichment belongs here."""

from __future__ import annotations

import math
from collections.abc import Mapping
from datetime import datetime
from uuid import UUID

MAX_DATA_FIELDS = 48

ADV_GROUPS = {
    "knowledge.retrieval.target.finished": "adv_attribution_enabled",
    "knowledge.retrieval.result.observed": "adv_quality_detail_enabled",
    "knowledge.retrieval.context.recorded": "adv_quality_detail_enabled",
    "knowledge.embedding.call.finished": "adv_model_storage_enabled",
    "knowledge.storage.operation.finished": "adv_model_storage_enabled",
    "knowledge.generation.task.finished": "adv_model_storage_enabled",
    "knowledge.document.read.finished": "adv_read_wiki_enabled",
    "knowledge.wiki.connection_test.finished": "adv_read_wiki_enabled",
    "knowledge.wiki.binding.request.finished": "adv_read_wiki_enabled",
    "knowledge.wiki.binding.changed": "adv_read_wiki_enabled",
}

EVENT_TYPES = frozenset(
    f"knowledge.{name}"
    for name in (
        "kb.created",
        "kb.deleted",
        "document.created",
        "document.deleted",
        "document.content.updated",
        "document.index_cleanup.finished",
        "index.dispatch.finished",
        "index.dispatch.skipped",
        "index.attempt.started",
        "index.attempt.finished",
        "index.generation.terminal",
        "index.execution.finished",
        "conversion.dispatch.finished",
        "conversion.attempt.started",
        "conversion.attempt.finished",
        "conversion.callback.finished",
        "retrieval.request.finished",
        "retrieval.execution.finished",
        "usage.kb.recorded",
        "usage.document.recorded",
        "external.sync.started",
        "external.sync.finished",
        "external.document.checked",
        "external.import.dispatched",
        "external.import.attempt.finished",
        "external.body.landed",
        "code_wiki.generation.started",
        "code_wiki.generation.finished",
        "code_wiki.publish.finished",
        "summary.attempt.finished",
    )
) | frozenset(ADV_GROUPS)

FIELDS = frozenset(
    {
        "kb_type",
        "source_type",
        "delete_mode",
        "trigger",
        "file_extension",
        "content_bytes",
        "had_active_index",
        "reindex_requested",
        "generation",
        "attempt",
        "task_id",
        "request_id",
        "operation_id",
        "parent_operation_id",
        "user_id",
        "reason",
        "reason_code",
        "route",
        "retry_scheduled",
        "preservation_reason",
        "execution_mode",
        "chunk_count",
        "knowledge_base_ids",
        "requested_kb_ids",
        "entrypoint",
        "client_surface",
        "route_mode",
        "result_count",
        "total_estimated_tokens",
        "restricted_mode",
        "provider",
        "decision",
        "callback_type",
        "accepted",
        "converter",
        "media_type",
        "generation_type",
        "published",
        "target_kind",
        "model_id",
        "model_provider",
        "started_at",
        "finished_at",
        "index_scheduled",
        "deleted_chunks",
        "indexed_count",
        "document_ref",
        "stage",
        "source_version",
        "action",
        "index_task_id",
        "callback_status",
        "task_state",
        "result_status",
        "previous_status",
        "storage_type",
        "retriever_name",
        "retriever_namespace",
        "embedding_model_name",
        "embedding_model_namespace",
        "model_role",
        "model_name",
        "model_namespace",
        "protocol",
        "operation",
        "retrieval_mode",
        "top_k",
        "score_threshold",
        "subtask_id",
        "offset",
        "returned_length",
        "total_length",
        "has_more",
        "connection_id",
        "connector_type",
        "ok",
        "version",
        "execution_id",
        "rank",
        "score",
        "returned_count",
        "context_id",
        "injection_mode",
        "invocation_id",
        "actor_user_id",
        "actor_employee_id",
        "actor_type",
        "effective_reader_id",
        "actor_org_id",
        "actor_org_version",
        "asset_org_id",
        "asset_org_version",
        "asset_org_by_kb",
        "usage_stage",
        "metric_definition_version",
        "batch_id",
        "batch_part",
        "expected_document_count",
        "content_revision",
        "content_changed_at",
        "snapshot_id",
        "source_watermark",
        "coverage_state",
    }
)


def scalar(value: object) -> object:
    if value is None or type(value) is bool:
        return value
    if isinstance(value, str):
        if len(value) > 256:
            raise ValueError("event_string_too_large")
        return value
    if type(value) is int:
        if value.bit_length() > 64:
            raise ValueError("event_integer_too_large")
        return value
    if type(value) is float and math.isfinite(value):
        return value
    if isinstance(value, (UUID, datetime)):
        return str(value)
    raise ValueError("unsupported_event_value")


def payload(event_type: str, data: object) -> dict[str, object]:
    if (
        event_type not in EVENT_TYPES
        or not isinstance(data, Mapping)
        or len(data) > MAX_DATA_FIELDS
    ):
        raise ValueError("invalid_event_contract")
    result = {}
    for key, value in data.items():
        if key not in FIELDS:
            raise ValueError("unknown_event_field")
        if key == "asset_org_by_kb":
            if type(value) is not list:
                raise ValueError("invalid_kb_ownership_list")
            entries = []
            for entry in value:
                if (
                    type(entry) is not dict
                    or "kb_id" not in entry
                    or not entry.keys()
                    <= {"kb_id", "asset_org_id", "asset_org_version"}
                ):
                    raise ValueError("invalid_kb_ownership_entry")
                if type(entry["kb_id"]) not in (int, str):
                    raise ValueError("invalid_kb_ownership_id")
                if any(
                    type(entry[k]) is not str
                    for k in ("asset_org_id", "asset_org_version")
                    if k in entry
                ):
                    raise ValueError("invalid_kb_ownership_organization")
                entries.append({k: scalar(v) for k, v in entry.items()})
            result[key] = entries
        elif key in {"knowledge_base_ids", "requested_kb_ids"}:
            if type(value) not in (tuple, list):
                raise ValueError("invalid_id_list")
            result[key] = [scalar(item) for item in value]
        else:
            result[key] = scalar(value)
    return result
