# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Task-level external knowledge reference helpers."""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Any

import app.stores.tasks as task_stores
from app.schemas.external_knowledge import (
    ExternalKnowledgeBindingLevel,
    ExternalKnowledgeRef,
)

if TYPE_CHECKING:
    from sqlalchemy.orm import Session

    from app.models.task import TaskResource

logger = logging.getLogger(__name__)


def normalize_external_knowledge_refs(raw_refs: list | None) -> list[dict[str, Any]]:
    """Validate and normalize external knowledge refs, dropping invalid entries."""
    normalized_refs: list[dict[str, Any]] = []
    for ref in raw_refs or []:
        try:
            normalized_refs.append(
                ExternalKnowledgeRef.model_validate(ref).model_dump(exclude_none=True)
            )
        except Exception:
            logger.warning(
                "Ignoring invalid external knowledge ref: %s",
                ref,
                exc_info=True,
            )
    return normalized_refs


def dedup_external_knowledge_refs(
    refs: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Union-dedup refs by source and target, preserving first-seen order."""
    seen: set[tuple[Any, ...]] = set()
    deduped: list[dict[str, Any]] = []
    for ref in refs:
        key = _target_key(ref)
        if key in seen:
            continue
        seen.add(key)
        deduped.append(ref)
    return deduped


def merge_external_knowledge_refs(
    existing_refs: list[dict[str, Any]],
    incoming_refs: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Append refs while enforcing whole-KB and child-target exclusivity."""
    merged = dedup_external_knowledge_refs(existing_refs)

    for incoming in incoming_refs:
        incoming_scope = _scope_key(incoming)
        incoming_target_type = _target_type(incoming)

        if incoming_target_type == "knowledge_base":
            merged = [ref for ref in merged if _scope_key(ref) != incoming_scope]
        else:
            merged = [
                ref
                for ref in merged
                if not (
                    _scope_key(ref) == incoming_scope
                    and _target_type(ref) == "knowledge_base"
                )
            ]

        merged.append(incoming)
        merged = dedup_external_knowledge_refs(merged)

    return merged


def validate_external_knowledge_refs(
    refs: list[dict[str, Any]],
    *,
    binding_level: ExternalKnowledgeBindingLevel,
) -> None:
    """Dispatch external ref validation to provider hooks."""
    if not refs:
        return

    from app.services.rag.sources import validate_external_refs

    validate_external_refs(
        [ExternalKnowledgeRef.model_validate(ref) for ref in refs],
        binding_level=binding_level,
    )


def extract_task_external_knowledge_refs(task: "TaskResource") -> list[dict[str, Any]]:
    """Return normalized external knowledge refs from task spec."""
    spec = (task.json or {}).get("spec") or {}
    return dedup_external_knowledge_refs(
        normalize_external_knowledge_refs(spec.get("externalKnowledgeRefs") or [])
    )


def sync_task_external_knowledge_refs(
    db: "Session",
    task: "TaskResource",
    refs: list[dict[str, Any]] | None,
) -> list[dict[str, Any]]:
    """Update task-level external refs as the runtime source of truth.

    The caller owns transaction boundaries. This helper intentionally does not
    commit so context creation and task-spec materialization can be atomic.
    """
    normalized_refs = normalize_external_knowledge_refs(refs or [])
    if not normalized_refs:
        return extract_task_external_knowledge_refs(task)

    task_json = task.json if isinstance(task.json, dict) else {}
    spec = task_json.setdefault("spec", {})
    existing_refs = normalize_external_knowledge_refs(
        spec.get("externalKnowledgeRefs") or []
    )
    next_refs = merge_external_knowledge_refs(existing_refs, normalized_refs)

    if existing_refs == next_refs:
        return next_refs

    if next_refs:
        spec["externalKnowledgeRefs"] = next_refs
    else:
        spec.pop("externalKnowledgeRefs", None)
    task_json["spec"] = spec
    task_stores.task_store.update_json(db, task=task, payload=task_json)
    return next_refs


def _scope_key(ref: dict[str, Any]) -> tuple[Any, Any, Any]:
    return (ref.get("provider"), ref.get("mode"), ref.get("id"))


def _target_type(ref: dict[str, Any]) -> str:
    return str(ref.get("target_type") or "knowledge_base")


def _target_key(ref: dict[str, Any]) -> tuple[Any, ...]:
    return (
        ref.get("provider"),
        ref.get("mode"),
        ref.get("id"),
        _target_type(ref),
        ref.get("node_id"),
        ref.get("document_id"),
    )
