# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Persist sender-approved message knowledge selections on a Task."""

from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Any, Iterable

import app.stores.tasks as task_stores
from app.models.kind import Kind
from app.models.subtask_context import ContextStatus
from app.models.user import User
from app.services.chat.external_knowledge_refs import (
    build_external_knowledge_warning,
    build_external_ref_canonical_key,
    build_internal_knowledge_warning,
    dedup_context_warnings,
    filter_valid_external_knowledge_refs,
    upsert_external_knowledge_refs,
)
from app.services.chat.knowledge_binding_resolver import KnowledgeBindingResolver
from app.services.knowledge.task_knowledge_base_service import (
    TaskKnowledgeBaseService,
)
from app.services.rag.sources import ExternalRefValidationError

if TYPE_CHECKING:
    from sqlalchemy.orm import Session

    from app.models.subtask_context import SubtaskContext
    from app.models.task import TaskResource

MAX_TASK_KNOWLEDGE_BASES = TaskKnowledgeBaseService.MAX_BOUND_KNOWLEDGE_BASES


def upsert_message_knowledge_bindings(
    db: "Session",
    task: "TaskResource",
    internal_contexts: Iterable["SubtaskContext"],
    external_contexts: Iterable["SubtaskContext"],
    actor_user_id: int,
    *,
    context_warnings: list[dict[str, Any]] | None = None,
    warning_scope_keys: set[str] | None = None,
) -> "TaskResource":
    """Upsert READY message selections after locking and validating as Task owner.

    The caller owns the transaction and commit. Sender permission checks must run
    before this function so rejected contexts are already marked FAILED.
    """
    all_internal = list(internal_contexts)
    all_external = list(external_contexts)
    if not all_internal and not all_external and not warning_scope_keys:
        return task

    ready_internal = _ready_contexts(all_internal)
    ready_external = _ready_contexts(all_external)
    if (
        not ready_internal
        and not ready_external
        and not warning_scope_keys
        and not context_warnings
    ):
        return task
    selected_keys = set(warning_scope_keys or ())
    selected_keys.update(_context_warning_keys(ready_internal, ready_external))

    locked_task = task_stores.task_store.get_by_id_for_update(db, task_id=task.id)
    if locked_task is None:
        raise ValueError(f"Task {task.id} no longer exists")

    actor = _get_active_user(db, actor_user_id)
    valid_internal, valid_external_refs, owner_warnings = _resolve_owner_bindings(
        db,
        locked_task,
        ready_internal,
        ready_external,
        actor,
    )
    return _update_task_bindings(
        db,
        locked_task,
        valid_internal,
        valid_external_refs,
        bound_by=actor.user_name if actor else "",
        selected_keys=selected_keys,
        warnings=(context_warnings or []) + owner_warnings,
    )


def _resolve_owner_bindings(
    db: "Session",
    task: "TaskResource",
    internal_contexts: list["SubtaskContext"],
    external_contexts: list["SubtaskContext"],
    actor: User | None,
) -> tuple[list["SubtaskContext"], list[dict[str, Any]], list[dict[str, Any]]]:
    owner = KnowledgeBindingResolver(db).resolve_task_owner_user(task=task)
    if actor is None or owner is None:
        return [], [], _missing_actor_warnings(internal_contexts, external_contexts)
    valid_internal, internal_warnings = _filter_internal_for_owner(
        db, internal_contexts, owner.id
    )
    valid_external, external_warnings = _filter_external_for_owner(
        external_contexts, owner.id
    )
    warnings = _describe_owner_warnings(internal_warnings + external_warnings)
    return valid_internal, valid_external, warnings


def _update_task_bindings(
    db: "Session",
    task: "TaskResource",
    internal_contexts: list["SubtaskContext"],
    external_refs: list[dict[str, Any]],
    *,
    bound_by: str,
    selected_keys: set[str],
    warnings: list[dict[str, Any]],
) -> "TaskResource":
    task_json = deepcopy(task.json) if isinstance(task.json, dict) else {}
    spec = task_json.setdefault("spec", {})
    limit_warnings: list[dict[str, Any]] = []
    if internal_contexts:
        limit_warnings = _upsert_internal_spec(
            db,
            spec,
            internal_contexts,
            bound_by=bound_by,
        )
    _upsert_external_spec(
        spec,
        external_refs,
        bound_by=bound_by,
    )
    spec["contextWarnings"] = _replace_selected_warnings(
        spec.get("contextWarnings") or [],
        selected_keys,
        warnings + limit_warnings,
    )
    task_json["spec"] = spec
    if task_json != task.json:
        task_stores.task_store.update_json(db, task=task, payload=task_json)
    return task


def _ready_contexts(contexts: Iterable["SubtaskContext"]) -> list["SubtaskContext"]:
    return [
        context for context in contexts if context.status == ContextStatus.READY.value
    ]


def _get_active_user(db: "Session", user_id: int) -> User | None:
    return db.query(User).filter(User.id == user_id, User.is_active.is_(True)).first()


def _filter_internal_for_owner(
    db: "Session",
    contexts: list["SubtaskContext"],
    owner_user_id: int,
) -> tuple[list["SubtaskContext"], list[dict[str, Any]]]:
    refs = [
        {"id": context.knowledge_id}
        for context in contexts
        if context.knowledge_id is not None
    ]
    valid_refs, warnings = KnowledgeBindingResolver(db).filter_internal_bindings(
        refs=refs,
        actor_user_id=owner_user_id,
    )
    valid_ids = {int(ref["id"]) for ref in valid_refs}
    return (
        [context for context in contexts if context.knowledge_id in valid_ids],
        warnings,
    )


def _filter_external_for_owner(
    contexts: list["SubtaskContext"],
    owner_user_id: int,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    refs = _external_refs_from_contexts(contexts)
    return filter_valid_external_knowledge_refs(
        refs,
        binding_level="conversation",
        actor_user_id=owner_user_id,
    )


def _upsert_internal_spec(
    db: "Session",
    spec: dict[str, Any],
    contexts: list["SubtaskContext"],
    *,
    bound_by: str,
) -> list[dict[str, Any]]:
    snapshots = _build_internal_snapshots(db, contexts, bound_by=bound_by)
    refs, scopes, rejected_ids = upsert_internal_knowledge_bindings(
        spec.get("knowledgeBaseRefs") or [],
        spec.get("knowledgeBaseScopes") or [],
        snapshots,
        max_knowledge_bases=MAX_TASK_KNOWLEDGE_BASES,
    )
    spec["knowledgeBaseRefs"] = refs
    spec["knowledgeBaseScopes"] = scopes
    return [_limit_warning(knowledge_base_id) for knowledge_base_id in rejected_ids]


def _upsert_external_spec(
    spec: dict[str, Any],
    refs: list[dict[str, Any]],
    *,
    bound_by: str,
) -> None:
    if not refs:
        return
    bound_at = _binding_timestamp()
    snapshots = [{**ref, "boundBy": bound_by, "boundAt": bound_at} for ref in refs]
    spec["externalKnowledgeRefs"] = upsert_external_knowledge_refs(
        spec.get("externalKnowledgeRefs") or [],
        snapshots,
    )


def _build_internal_snapshots(
    db: "Session",
    contexts: list["SubtaskContext"],
    *,
    bound_by: str,
) -> list[dict[str, Any]]:
    selections = _group_internal_contexts(contexts)
    if not selections:
        return []
    knowledge_bases = (
        db.query(Kind)
        .filter(
            Kind.id.in_(selections),
            Kind.kind == "KnowledgeBase",
            Kind.is_active.is_(True),
        )
        .all()
    )
    knowledge_bases_by_id = {
        knowledge_base.id: knowledge_base for knowledge_base in knowledge_bases
    }
    bound_at = _binding_timestamp()
    return [
        _build_internal_snapshot(
            selection,
            knowledge_bases_by_id[knowledge_base_id],
            bound_by=bound_by,
            bound_at=bound_at,
        )
        for knowledge_base_id, selection in selections.items()
        if knowledge_base_id in knowledge_bases_by_id
    ]


def _group_internal_contexts(
    contexts: Iterable["SubtaskContext"],
) -> dict[int, dict[str, Any]]:
    grouped: dict[int, dict[str, Any]] = {}
    for context in contexts:
        if context.knowledge_id is None:
            continue
        knowledge_base_id = int(context.knowledge_id)
        data = context.type_data if isinstance(context.type_data, dict) else {}
        current = grouped.setdefault(
            knowledge_base_id,
            {
                "id": knowledge_base_id,
                "scope_restricted": True,
                "document_ids": [],
                "folder_ids": [],
                "include_subfolders": True,
            },
        )
        if not bool(data.get("scope_restricted", False)):
            current["scope_restricted"] = False
            current["document_ids"] = []
            current["folder_ids"] = []
            continue
        if not current["scope_restricted"]:
            continue
        current["document_ids"] = _merge_int_values(
            current["document_ids"], data.get("document_ids") or []
        )
        current["folder_ids"] = _merge_int_values(
            current["folder_ids"], data.get("folder_ids") or [], allow_zero=True
        )
        current["include_subfolders"] = bool(data.get("include_subfolders", True))
    return grouped


def _merge_int_values(
    existing: list[int],
    incoming: Iterable[Any],
    *,
    allow_zero: bool = False,
) -> list[int]:
    result = list(existing)
    seen = set(result)
    minimum = 0 if allow_zero else 1
    for value in incoming:
        try:
            normalized = int(value)
        except (TypeError, ValueError):
            continue
        if normalized < minimum or normalized in seen:
            continue
        result.append(normalized)
        seen.add(normalized)
    return result


def _build_internal_snapshot(
    selection: dict[str, Any],
    knowledge_base: Kind,
    *,
    bound_by: str,
    bound_at: str,
) -> dict[str, Any]:
    kb_spec = knowledge_base.json.get("spec", {}) if knowledge_base.json else {}
    snapshot = {
        **selection,
        "name": kb_spec.get("name") or knowledge_base.name,
        "namespace": knowledge_base.namespace,
        "boundBy": bound_by,
        "boundAt": bound_at,
    }
    return snapshot


def upsert_internal_knowledge_bindings(
    existing_refs: list[dict[str, Any]],
    existing_scopes: list[dict[str, Any]],
    incoming_snapshots: list[dict[str, Any]],
    *,
    max_knowledge_bases: int,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[int]]:
    """Upsert whole/scoped internal KB snapshots by stable KB ID."""
    refs = [dict(ref) for ref in existing_refs if isinstance(ref, dict)]
    scopes = [dict(ref) for ref in existing_scopes if isinstance(ref, dict)]
    bound_ids = _bound_internal_ids(refs, scopes)
    rejected_ids: list[int] = []
    for snapshot in incoming_snapshots:
        knowledge_base_id = int(snapshot["id"])
        if knowledge_base_id not in bound_ids and len(bound_ids) >= max_knowledge_bases:
            rejected_ids.append(knowledge_base_id)
            continue
        refs = [ref for ref in refs if ref.get("id") != knowledge_base_id]
        scopes = [ref for ref in scopes if ref.get("id") != knowledge_base_id]
        if snapshot.get("scope_restricted"):
            scopes.append(_scope_ref(snapshot))
        else:
            refs.append(_whole_ref(snapshot))
        bound_ids.add(knowledge_base_id)
    return refs, scopes, rejected_ids


def _bound_internal_ids(
    refs: list[dict[str, Any]], scopes: list[dict[str, Any]]
) -> set[int]:
    result: set[int] = set()
    for ref in refs + scopes:
        try:
            result.add(int(ref["id"]))
        except (KeyError, TypeError, ValueError):
            continue
    return result


def _whole_ref(snapshot: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": snapshot["id"],
        "name": snapshot["name"],
        "boundBy": snapshot["boundBy"],
        "boundAt": snapshot["boundAt"],
    }


def _scope_ref(snapshot: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": snapshot["id"],
        "namespace": snapshot["namespace"],
        "name": snapshot["name"],
        "scopeRestricted": True,
        "folderIds": snapshot.get("folder_ids") or None,
        "explicitDocumentIds": snapshot.get("document_ids") or [],
        "includeSubfolders": bool(snapshot.get("include_subfolders", True)),
        "boundBy": snapshot["boundBy"],
        "boundAt": snapshot["boundAt"],
    }


def _external_refs_from_contexts(
    contexts: Iterable["SubtaskContext"],
) -> list[dict[str, Any]]:
    refs: list[dict[str, Any]] = []
    for context in contexts:
        type_data = context.type_data if isinstance(context.type_data, dict) else {}
        ref = type_data.get("external_ref")
        if isinstance(ref, dict):
            refs.append({key: value for key, value in ref.items() if value is not None})
    return refs


def _context_warning_keys(
    internal_contexts: Iterable["SubtaskContext"],
    external_contexts: Iterable["SubtaskContext"],
) -> set[str]:
    internal_keys = {
        f"internal:{context.knowledge_id}"
        for context in internal_contexts
        if context.knowledge_id is not None
    }
    external_keys = {
        build_external_ref_canonical_key(ref)
        for ref in _external_refs_from_contexts(external_contexts)
    }
    return internal_keys | external_keys


def _missing_actor_warnings(
    internal_contexts: list["SubtaskContext"],
    external_contexts: list["SubtaskContext"],
) -> list[dict[str, Any]]:
    warnings = [
        build_internal_knowledge_warning(
            knowledge_base_id=int(context.knowledge_id),
            reason="actor_not_found",
        )
        for context in internal_contexts
        if context.knowledge_id is not None
    ]
    error = ExternalRefValidationError(
        "Conversation owner is unavailable", reason="actor_not_found"
    )
    warnings.extend(
        build_external_knowledge_warning(ref, error)
        for ref in _external_refs_from_contexts(external_contexts)
    )
    return warnings


def _describe_owner_warnings(
    warnings: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for warning in warnings:
        described = dict(warning)
        described["message"] = (
            "This source is available for the current message but was not added "
            "to the conversation because the conversation owner cannot access it."
        )
        result.append(described)
    return result


def _limit_warning(knowledge_base_id: int) -> dict[str, Any]:
    warning = build_internal_knowledge_warning(
        knowledge_base_id=knowledge_base_id,
        reason="limit_reached",
    )
    warning["message"] = (
        f"This knowledge base was not added because a conversation can bind at most "
        f"{MAX_TASK_KNOWLEDGE_BASES} knowledge bases."
    )
    return warning


def _replace_selected_warnings(
    existing_warnings: list[dict[str, Any]],
    selected_keys: set[str],
    incoming_warnings: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    external_prefixes = {
        _external_source_prefix(key)
        for key in selected_keys
        if key.startswith("external:")
    }
    retained = [
        warning
        for warning in existing_warnings
        if isinstance(warning, dict)
        and not _warning_matches_selection(
            warning,
            selected_keys=selected_keys,
            external_prefixes=external_prefixes,
        )
    ]
    return dedup_context_warnings(retained + incoming_warnings)


def _warning_matches_selection(
    warning: dict[str, Any],
    *,
    selected_keys: set[str],
    external_prefixes: set[str],
) -> bool:
    metadata = warning.get("metadata")
    canonical_key = metadata.get("canonicalKey") if isinstance(metadata, dict) else None
    if not isinstance(canonical_key, str):
        return False
    return canonical_key in selected_keys or any(
        canonical_key.startswith(prefix) for prefix in external_prefixes
    )


def _external_source_prefix(canonical_key: str) -> str:
    return ":".join(canonical_key.split(":", 4)[:4]) + ":"


def _binding_timestamp() -> str:
    return datetime.now(timezone.utc).isoformat()
