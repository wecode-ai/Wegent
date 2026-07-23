# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Task-level external knowledge reference helpers."""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Any

from pydantic import ValidationError

import app.stores.tasks as task_stores
from app.schemas.external_knowledge import (
    ExternalKnowledgeBindingLevel,
    ExternalKnowledgeRef,
    external_ref_canonical_key,
)
from app.services.rag.sources import ExternalRefValidationError

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


def upsert_external_knowledge_refs(
    existing_refs: list[dict[str, Any]],
    incoming_refs: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Replace selected source snapshots while preserving other sources.

    A source is identified by ``(provider, mode, id)``. All incoming targets for
    the same source form one complete snapshot, so existing targets for that
    source are removed before the new snapshot is appended.
    """
    incoming_by_source: dict[tuple[Any, ...], list[dict[str, Any]]] = {}
    for ref in dedup_external_knowledge_refs(incoming_refs):
        source_key = _scope_key(ref)
        incoming_by_source.setdefault(source_key, []).append(ref)

    if not incoming_by_source:
        return dedup_external_knowledge_refs(existing_refs)

    retained_refs = [
        ref
        for ref in dedup_external_knowledge_refs(existing_refs)
        if _scope_key(ref) not in incoming_by_source
    ]
    for source_refs in incoming_by_source.values():
        retained_refs.extend(merge_external_knowledge_refs([], source_refs))
    return dedup_external_knowledge_refs(retained_refs)


def validate_external_knowledge_refs(
    refs: list[dict[str, Any]],
    *,
    binding_level: ExternalKnowledgeBindingLevel,
    actor_user_id: int,
) -> None:
    """Dispatch external ref validation to provider hooks."""
    if not refs:
        return

    from app.services.rag.sources import validate_external_refs

    try:
        validated_refs = [ExternalKnowledgeRef.model_validate(ref) for ref in refs]
        validate_external_refs(
            validated_refs,
            binding_level=binding_level,
            actor_user_id=actor_user_id,
        )
    except ExternalRefValidationError:
        raise
    except (ValidationError, ValueError) as exc:
        raise ExternalRefValidationError(str(exc), reason="invalid_selection") from exc


def filter_valid_external_knowledge_refs(
    refs: list[dict[str, Any]],
    *,
    binding_level: ExternalKnowledgeBindingLevel,
    actor_user_id: int,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Return refs that pass provider gate plus sanitized warnings for failures."""
    normalized_refs, conflict_warnings = _normalize_external_refs_with_warnings(refs)
    valid_refs, warnings = _filter_external_ref_batch(
        normalized_refs,
        binding_level=binding_level,
        actor_user_id=actor_user_id,
    )
    return valid_refs, dedup_context_warnings(conflict_warnings + warnings)


def _normalize_external_refs_with_warnings(
    refs: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Keep whole-source refs and explain child refs dropped by conflicts."""
    normalized = dedup_external_knowledge_refs(normalize_external_knowledge_refs(refs))
    whole_scopes = {
        _scope_key(ref) for ref in normalized if _target_type(ref) == "knowledge_base"
    }
    retained: list[dict[str, Any]] = []
    warnings: list[dict[str, Any]] = []
    conflict = ExternalRefValidationError(
        "A whole-source binding already covers this child target",
        reason="unsupported_binding",
    )
    for ref in normalized:
        if _scope_key(ref) in whole_scopes and _target_type(ref) != "knowledge_base":
            warning = build_external_knowledge_warning(ref, conflict)
            warning["message"] = (
                "This child target was ignored because the whole knowledge source "
                "is already bound."
            )
            warnings.append(warning)
            continue
        retained.append(ref)
    return retained, warnings


def _filter_external_ref_batch(
    refs: list[dict[str, Any]],
    *,
    binding_level: ExternalKnowledgeBindingLevel,
    actor_user_id: int,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Gate the success path once and isolate individual failures by bounded splits."""
    if not refs:
        return [], []
    detailed = _validate_external_ref_batch_once(
        refs,
        binding_level=binding_level,
        actor_user_id=actor_user_id,
    )
    if detailed is not None:
        valid = [ref for ref, error in detailed if error is None]
        warnings = [
            build_external_knowledge_warning(ref, error)
            for ref, error in detailed
            if error is not None
        ]
        return valid, warnings
    try:
        validate_external_knowledge_refs(
            refs,
            binding_level=binding_level,
            actor_user_id=actor_user_id,
        )
        return refs, []
    except ExternalRefValidationError as exc:
        if len(refs) == 1:
            return [], [build_external_knowledge_warning(refs[0], exc)]

    midpoint = len(refs) // 2
    left_refs, left_warnings = _filter_external_ref_batch(
        refs[:midpoint],
        binding_level=binding_level,
        actor_user_id=actor_user_id,
    )
    right_refs, right_warnings = _filter_external_ref_batch(
        refs[midpoint:],
        binding_level=binding_level,
        actor_user_id=actor_user_id,
    )
    return merge_external_knowledge_refs(left_refs, right_refs), (
        left_warnings + right_warnings
    )


def _validate_external_ref_batch_once(
    refs: list[dict[str, Any]],
    *,
    binding_level: ExternalKnowledgeBindingLevel,
    actor_user_id: int,
) -> list[tuple[dict[str, Any], ExternalRefValidationError | None]] | None:
    """Use an optional provider per-ref API without recursive retry amplification."""
    from app.services.rag.sources import ExternalRefGateRequest
    from app.services.rag.sources.registry import retrieval_source_registry

    modeled = [ExternalKnowledgeRef.model_validate(ref) for ref in refs]
    providers = {ref.provider for ref in modeled}
    if len(providers) != 1:
        return None
    provider = retrieval_source_registry.get(next(iter(providers)))
    if provider is None:
        return None
    capabilities = getattr(provider, "capabilities", None)
    if binding_level == "agent" and (
        any(ref.mode == "all_accessible" for ref in modeled)
        or not getattr(capabilities, "enforces_per_user_access", False)
    ):
        return None
    validate_batch = getattr(provider, "validate_refs_batch", None)
    if not callable(validate_batch):
        return None
    results = validate_batch(
        gate=ExternalRefGateRequest(
            refs=modeled,
            binding_level=binding_level,
            actor_user_id=actor_user_id,
        )
    )
    if len(results) != len(refs):
        logger.warning("Provider returned an invalid per-ref validation result count")
        return None
    detailed: list[tuple[dict[str, Any], ExternalRefValidationError | None]] = []
    for ref, result in zip(refs, results):
        error = None
        if not result.is_valid:
            error = ExternalRefValidationError(
                result.message or "External knowledge ref is unavailable",
                reason=result.reason or "invalid_selection",
            )
        detailed.append((ref, error))
    return detailed


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
    next_refs = upsert_external_knowledge_refs(existing_refs, normalized_refs)

    if existing_refs == next_refs:
        return next_refs

    if next_refs:
        spec["externalKnowledgeRefs"] = next_refs
    else:
        spec.pop("externalKnowledgeRefs", None)
    task_json["spec"] = spec
    task_stores.task_store.update_json(db, task=task, payload=task_json)
    return next_refs


def sync_task_context_warnings(
    db: "Session",
    task: "TaskResource",
    warnings: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Merge sanitized context warnings into Task.spec without duplicates."""
    task_json = task.json if isinstance(task.json, dict) else {}
    spec = task_json.setdefault("spec", {})
    existing = [w for w in spec.get("contextWarnings") or [] if isinstance(w, dict)]
    next_warnings = dedup_context_warnings(existing + warnings)

    if existing == next_warnings:
        return next_warnings

    spec["contextWarnings"] = next_warnings
    task_json["spec"] = spec
    task_stores.task_store.update_json(db, task=task, payload=task_json)
    return next_warnings


def replace_task_context_warnings(
    db: "Session",
    task: "TaskResource",
    *,
    canonical_keys: set[str],
    warnings: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Replace warning state for one resolved binding scope atomically."""
    task_json = task.json if isinstance(task.json, dict) else {}
    spec = task_json.setdefault("spec", {})
    existing = [
        warning
        for warning in spec.get("contextWarnings") or []
        if isinstance(warning, dict)
        and _warning_canonical_key(warning) not in canonical_keys
    ]
    next_warnings = dedup_context_warnings(existing + warnings)
    if next_warnings:
        spec["contextWarnings"] = next_warnings
    else:
        spec["contextWarnings"] = []
    task_json["spec"] = spec
    task_stores.task_store.update_json(db, task=task, payload=task_json)
    return next_warnings


def lock_task_for_knowledge_update(
    db: "Session",
    task: "TaskResource",
) -> "TaskResource":
    """Lock and refresh a Task before concurrent knowledge warning updates."""
    locked = task_stores.task_store.get_by_id_for_update(db, task_id=task.id)
    return locked or task


def remove_task_external_knowledge_ref(
    db: "Session",
    task: "TaskResource",
    ref_to_remove: dict[str, Any],
) -> list[dict[str, Any]]:
    """Remove one task-level external ref by its normalized target key."""
    normalized = normalize_external_knowledge_refs([ref_to_remove])
    if not normalized:
        raise ExternalRefValidationError("Invalid external knowledge ref")

    remove_key = _target_key(normalized[0])
    task_json = task.json if isinstance(task.json, dict) else {}
    spec = task_json.setdefault("spec", {})
    existing_refs = normalize_external_knowledge_refs(
        spec.get("externalKnowledgeRefs") or []
    )
    next_refs = [ref for ref in existing_refs if _target_key(ref) != remove_key]

    if len(next_refs) == len(existing_refs):
        raise ExternalRefValidationError(
            "External knowledge ref is not bound to this task"
        )

    if next_refs:
        spec["externalKnowledgeRefs"] = next_refs
    else:
        spec.pop("externalKnowledgeRefs", None)
    task_json["spec"] = spec
    task_stores.task_store.update_json(db, task=task, payload=task_json)
    return next_refs


def _scope_key(ref: dict[str, Any]) -> tuple[Any, ...]:
    return (
        ref.get("provider"),
        ref.get("mode"),
        ref.get("id"),
    )


def _target_type(ref: dict[str, Any]) -> str:
    return str(ref.get("target_type") or "knowledge_base")


def _target_key(ref: dict[str, Any]) -> tuple[Any, ...]:
    return (
        ref.get("provider"),
        ref.get("mode"),
        ref.get("id"),
        _target_type(ref),
        ref.get("workspace_id"),
        ref.get("node_id"),
        ref.get("document_id"),
    )


def build_external_ref_canonical_key(ref: dict[str, Any]) -> str:
    """Return the canonical key shared by Task materialization and warnings."""
    return external_ref_canonical_key(ref)


def build_external_knowledge_warning(
    ref: dict[str, Any],
    exc: ExternalRefValidationError,
) -> dict[str, Any]:
    """Build a provider-neutral warning for an external binding failure."""
    source_name = ref.get("name") or ref.get("target_name") or ref.get("id")
    warning: dict[str, Any] = {
        "type": "external_knowledge",
        "reason": exc.reason,
        "provider": str(ref.get("provider") or ""),
        "id": str(ref.get("id") or ""),
        "message": _warning_message(exc.reason, "external_knowledge"),
        "metadata": {"canonicalKey": build_external_ref_canonical_key(ref)},
    }
    if source_name:
        warning["name"] = str(source_name)
    return warning


def build_internal_knowledge_warning(
    *,
    knowledge_base_id: int,
    reason: str = "access_denied",
) -> dict[str, Any]:
    """Build a provider-neutral warning for an internal knowledge binding failure."""
    return {
        "type": "knowledge_base",
        "reason": reason,
        "id": str(knowledge_base_id),
        "message": _warning_message(reason, "knowledge_base"),
        "metadata": {"canonicalKey": f"internal:{knowledge_base_id}"},
    }


def dedup_context_warnings(warnings: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Deduplicate context warnings while preserving first-seen order."""
    deduped: list[dict[str, Any]] = []
    seen: set[tuple[str, str, str, str | None]] = set()
    for warning in warnings:
        key = (
            str(warning.get("type") or ""),
            str(warning.get("reason") or ""),
            str(warning.get("id") or ""),
            _warning_canonical_key(warning),
        )
        if key in seen:
            continue
        seen.add(key)
        deduped.append(warning)
    return deduped


def _warning_canonical_key(warning: dict[str, Any]) -> str | None:
    metadata = warning.get("metadata")
    if isinstance(metadata, dict):
        canonical_key = metadata.get("canonicalKey")
        if canonical_key:
            key = str(canonical_key)
            # Before document_id was added, persisted external warning keys
            # ended after node_id. Normalize that shape so repairing the same
            # selection can remove its legacy warning without a migration.
            if key.startswith("external:") and key.count(":") == 6:
                return f"{key}:"
            return key
    if warning.get("type") == "external_knowledge":
        return build_external_ref_canonical_key(
            {
                "provider": warning.get("provider"),
                "mode": warning.get("mode") or "explicit",
                "id": warning.get("id"),
                "target_type": warning.get("target_type"),
                "workspace_id": warning.get("workspace_id"),
                "node_id": warning.get("node_id"),
                "document_id": warning.get("document_id"),
            }
        )
    return None


def _warning_message(reason: str, warning_type: str) -> str:
    if warning_type == "knowledge_base":
        if reason == "actor_not_found":
            return "The owner required for this knowledge base is no longer available."
        return "Knowledge base binding was not applied for the current user."
    return {
        "actor_not_found": "The owner required for this knowledge source is no longer available.",
        "not_configured": "External knowledge source is not configured for the current user.",
        "access_denied": "External knowledge source is not available for the current user.",
        "inactive_or_deleted": "External knowledge source is inactive, deleted, or not synced.",
        "provider_unavailable": "External knowledge provider is currently unavailable.",
        "invalid_selection": "External knowledge selection is invalid.",
        "sync_required": "External knowledge source must be synced before it can be used.",
        "unsupported_binding": "External knowledge source cannot be used for this binding.",
    }.get(reason, "External knowledge source is not available for the current user.")
