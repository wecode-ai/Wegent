# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Build the provider-neutral selected knowledge execution context."""

from __future__ import annotations

import logging
from collections.abc import Iterable, Sequence
from dataclasses import replace
from typing import TYPE_CHECKING, Any, NoReturn

from fastapi import HTTPException

from app.models.knowledge import KnowledgeDocument, KnowledgeFolder
from app.models.subtask_context import ContextStatus, ContextType, SubtaskContext
from app.services.execution.skill_mcp import extract_skill_mcp_servers
from app.services.mcp_provider_registry import get_mcp_service_by_skill_name
from shared.models.knowledge import (
    KnowledgeBaseToolAccessMode,
    KnowledgeScopeType,
    SelectedKnowledgeContext,
    SelectedKnowledgeRef,
    SelectedKnowledgeResource,
)
from shared.prompts import render_selected_knowledge_prompt
from shared.selected_knowledge import resolve_selected_knowledge_context

if TYPE_CHECKING:
    from sqlalchemy.orm import Session

    from app.models.task import TaskResource
    from shared.models.execution import ExecutionRequest


logger = logging.getLogger(__name__)

PROVIDER_SKILLS = {
    "wegent": "wegent-knowledge",
    "dingtalk": "dingtalk-docs",
}
SUPPORTED_PROVIDER_NATIVE_SHELLS = {"Chat", "ClaudeCode"}
ROUTING_SUMMARY_MAX_LENGTH = 200
ROUTING_TOPIC_MAX_LENGTH = 48
MAX_ROUTING_TOPICS = 5


def register_provider_skill(provider_id: str, skill_name: str) -> None:
    """Register a deployment-specific provider Skill before execution."""
    provider_id = provider_id.strip().lower()
    skill_name = skill_name.strip()
    if not provider_id or not skill_name:
        raise ValueError("Provider ID and Skill name must not be empty")
    PROVIDER_SKILLS[provider_id] = skill_name


def apply_selected_knowledge_context(
    db: "Session",
    request: "ExecutionRequest",
    task: "TaskResource",
    *,
    current_contexts: Sequence[SubtaskContext] = (),
    context: SelectedKnowledgeContext | None = None,
) -> list[str]:
    """Attach the selected-knowledge prompt and deterministic provider skills."""
    current_contexts = tuple(current_contexts)
    if context is None:
        context = build_selected_knowledge_context(
            db,
            request,
            task,
            current_contexts=current_contexts,
        )
    if not context.refs:
        request.selected_knowledge_prompt = ""
        request.provider_native_knowledge = False
        return []

    shell_type = get_request_shell_type(request)
    if shell_type not in SUPPORTED_PROVIDER_NATIVE_SHELLS:
        request.selected_knowledge_prompt = ""
        request.provider_native_knowledge = False
        return []

    prompt = render_selected_knowledge_prompt(context)
    if not prompt:
        request.selected_knowledge_prompt = ""
        request.provider_native_knowledge = False
        return []

    request.selected_knowledge_prompt = prompt
    request.provider_native_knowledge = False

    request.preload_skills = list(request.preload_skills or [])
    request.user_selected_skills = list(request.user_selected_skills or [])

    selected_skills: list[str] = []
    for ref in context.refs:
        skill_name = PROVIDER_SKILLS.get(ref.provider)
        if not skill_name or skill_name in selected_skills:
            continue
        selected_skills.append(skill_name)
        _append_unique(request.preload_skills, skill_name)
        _append_unique(request.user_selected_skills, skill_name)

    return selected_skills


def activate_provider_native_knowledge(
    request: "ExecutionRequest",
    provider_skills: list[str],
) -> None:
    """Activate provider-native access or user-facing configuration guidance."""
    request.provider_native_knowledge = False
    if not provider_skills:
        return

    skill_names = set(request.skill_names or [])
    skill_configs = {
        config.get("name"): config
        for config in request.skill_configs or []
        if isinstance(config, dict) and config.get("name")
    }
    missing_skills = [
        skill_name
        for skill_name in provider_skills
        if skill_name not in skill_names or skill_name not in skill_configs
    ]
    if missing_skills:
        _raise_capability_error(
            "Required provider Skill is unavailable: " + ", ".join(missing_skills)
        )

    expected_mcp_names: set[str] = set()
    invalid_mcp_skills: list[str] = []
    for skill_name in provider_skills:
        valid_servers = [
            server
            for server in extract_skill_mcp_servers([skill_configs[skill_name]])
            if server.get("url")
        ]
        if not valid_servers:
            runtime_service = get_mcp_service_by_skill_name(skill_name)
            if runtime_service and runtime_service[0]["configuration_mode"] == "user":
                continue
            invalid_mcp_skills.append(skill_name)
            continue
        expected_mcp_names.update(server["name"] for server in valid_servers)

    if invalid_mcp_skills:
        _raise_capability_error(
            "Required provider Skill has no enabled MCP URL: "
            + ", ".join(invalid_mcp_skills)
        )

    if get_request_shell_type(request) == "ClaudeCode":
        bot_config = (
            request.bot[0] if request.bot and isinstance(request.bot[0], dict) else {}
        )
        configured_mcp_names = {
            server.get("name")
            for server in bot_config.get("mcp_servers", []) or []
            if isinstance(server, dict) and server.get("name")
        }
        missing_mcp_names = sorted(expected_mcp_names - configured_mcp_names)
        if missing_mcp_names:
            _raise_capability_error(
                "Required provider MCP is unavailable to ClaudeCode: "
                + ", ".join(missing_mcp_names)
            )

    request.provider_native_knowledge = True


def get_request_shell_type(request: "ExecutionRequest") -> str:
    """Return the effective primary shell type."""
    if request.bot and isinstance(request.bot[0], dict):
        return str(request.bot[0].get("shell_type") or "Chat")
    return "Chat"


def _raise_capability_error(detail: str) -> NoReturn:
    raise HTTPException(status_code=503, detail=detail)


def _raise_invalid_selection_error(detail: str) -> NoReturn:
    raise HTTPException(status_code=400, detail=detail)


def build_selected_knowledge_refs(
    db: "Session",
    request: "ExecutionRequest",
    task: "TaskResource",
) -> list[SelectedKnowledgeRef]:
    """Normalize internal task scopes and external refs without querying content."""
    refs = [*_build_wegent_refs(db, request, task), *_build_external_refs(request)]
    context = resolve_selected_knowledge_context(task_refs=refs, explicit_refs=())
    return list(context.refs)


def build_inherited_selected_knowledge_refs(
    db: "Session",
    task: "TaskResource",
    user_id: int,
    *,
    external_refs: Iterable[Any] = (),
) -> list[SelectedKnowledgeRef]:
    """Build task-bound and agent-default refs from their persisted sources."""
    from app.services.chat.task_default_knowledge_bases import (
        resolve_task_default_knowledge_base_ids,
    )

    task_json: dict[str, Any] = task.json if isinstance(task.json, dict) else {}
    raw_spec = task_json.get("spec")
    spec: dict[str, Any] = raw_spec if isinstance(raw_spec, dict) else {}
    persisted_ids = [
        *_index_refs_by_integer_id(spec.get("knowledgeBaseRefs")),
        *_index_refs_by_integer_id(spec.get("knowledgeBaseScopes")),
    ]
    default_ids = resolve_task_default_knowledge_base_ids(db, task.id, user_id)
    selected_ids = list(dict.fromkeys([*persisted_ids, *default_ids]))
    refs = [
        *_build_wegent_refs_for_ids(db, task, selected_ids),
        *_build_external_refs_from_values(external_refs),
    ]
    context = resolve_selected_knowledge_context(task_refs=refs, explicit_refs=())
    return list(context.refs)


def build_selected_knowledge_context(
    db: "Session",
    request: "ExecutionRequest",
    task: "TaskResource",
    *,
    current_contexts: Sequence[SubtaskContext] = (),
    inherited_refs: Sequence[SelectedKnowledgeRef] | None = None,
    user_id: int | None = None,
) -> SelectedKnowledgeContext:
    """Resolve explicit message contexts over inherited task knowledge refs."""
    current_contexts = tuple(current_contexts)
    validate_explicit_knowledge_contexts(current_contexts)
    _validate_explicit_external_contexts(current_contexts)
    task_refs = (
        list(inherited_refs)
        if inherited_refs is not None
        else (build_selected_knowledge_refs(db, request, task))
    )
    explicit_refs = _build_current_explicit_refs(
        db,
        current_contexts=current_contexts,
    )
    explicit_keys = {(ref.provider, ref.knowledge_base_id) for ref in explicit_refs}
    empty_explicit_keys = _explicit_context_keys(current_contexts) - explicit_keys
    if empty_explicit_keys:
        task_refs = [
            ref
            for ref in task_refs
            if (ref.provider, ref.knowledge_base_id) not in empty_explicit_keys
        ]
    context = resolve_selected_knowledge_context(task_refs, explicit_refs)
    if has_explicit_knowledge_context(current_contexts):
        context = replace(context, evidence_required=True)
    access_mode = request.kb_tool_access_mode
    if user_id is not None:
        access_mode = _resolve_effective_wegent_access_mode(db, context, user_id)
    context = _filter_native_refs(context, access_mode)
    return _enrich_wegent_routing_metadata(db, context)


def _resolve_effective_wegent_access_mode(
    db: "Session",
    context: SelectedKnowledgeContext,
    user_id: int,
) -> str:
    """Resolve tool exposure against every effective internal source."""
    from app.services.knowledge.knowledge_access_policy import (
        get_knowledge_base_tool_access_mode_by_ids,
    )

    knowledge_base_ids = [
        knowledge_base_id
        for ref in context.refs
        if ref.provider == "wegent"
        and (knowledge_base_id := _positive_int(ref.knowledge_base_id)) is not None
    ]
    access_mode, _ = get_knowledge_base_tool_access_mode_by_ids(
        db,
        user_id,
        knowledge_base_ids,
    )
    return access_mode


def _filter_native_refs(
    context: SelectedKnowledgeContext,
    access_mode: str,
) -> SelectedKnowledgeContext:
    """Apply Provider-specific native access policies to the final context."""
    if access_mode != KnowledgeBaseToolAccessMode.RESTRICTED_SEARCH_ONLY:
        return context
    return SelectedKnowledgeContext(
        refs=tuple(ref for ref in context.refs if ref.provider != "wegent"),
        evidence_required=context.evidence_required,
    )


def _enrich_wegent_routing_metadata(
    db: "Session",
    context: SelectedKnowledgeContext,
) -> SelectedKnowledgeContext:
    """Attach bounded Wegent metadata after the effective range is resolved."""
    wegent_ids = [
        kb_id
        for ref in context.refs
        if ref.provider == "wegent"
        and (kb_id := _positive_int(ref.knowledge_base_id)) is not None
    ]
    if not wegent_ids:
        return context

    from app.services.chat.preprocessing.kb_meta import sanitize_prompt_text
    from app.services.knowledge.task_knowledge_base_service import (
        task_knowledge_base_service,
    )

    try:
        knowledge_bases = task_knowledge_base_service.get_knowledge_bases_by_ids(
            db,
            wegent_ids,
        )
    except Exception:
        logger.warning(
            "Failed to load routing metadata for Wegent knowledge bases: %s",
            wegent_ids,
            exc_info=True,
        )
        return context

    enriched_refs: list[SelectedKnowledgeRef] = []
    for ref in context.refs:
        kb_id = _positive_int(ref.knowledge_base_id)
        knowledge_base = knowledge_bases.get(kb_id) if kb_id is not None else None
        if ref.provider != "wegent" or knowledge_base is None:
            enriched_refs.append(ref)
            continue
        spec = (
            knowledge_base.json.get("spec", {})
            if isinstance(knowledge_base.json, dict)
            else {}
        )
        summary = spec.get("summary")
        summary_data = summary if isinstance(summary, dict) else {}
        routing_summary = _routing_summary(spec, summary_data)
        routing_topics = _routing_topics(spec, summary_data)
        enriched_refs.append(
            replace(
                ref,
                knowledge_base_name=str(
                    spec.get("name")
                    or getattr(knowledge_base, "name", "")
                    or ref.knowledge_base_name
                ),
                routing_summary=sanitize_prompt_text(
                    routing_summary,
                    max_len=ROUTING_SUMMARY_MAX_LENGTH,
                )
                or None,
                routing_topics=tuple(
                    topic
                    for value in routing_topics[:MAX_ROUTING_TOPICS]
                    if (
                        topic := sanitize_prompt_text(
                            value,
                            max_len=ROUTING_TOPIC_MAX_LENGTH,
                        )
                    )
                ),
            )
        )
    return replace(context, refs=tuple(enriched_refs))


def _routing_summary(spec: dict[str, Any], summary: dict[str, Any]) -> str:
    manual_summary = summary.get("manual_long_summary")
    if manual_summary:
        return str(manual_summary)
    if not spec.get("summaryEnabled") or summary.get("status") != "completed":
        return ""
    return str(summary.get("short_summary") or "")


def _routing_topics(
    spec: dict[str, Any],
    summary: dict[str, Any],
) -> list[Any]:
    if not summary.get("manual_long_summary") and (
        not spec.get("summaryEnabled") or summary.get("status") != "completed"
    ):
        return []
    topics = summary.get("topics")
    return list(topics) if isinstance(topics, (list, tuple)) else []


def has_explicit_knowledge_context(contexts: Sequence[SubtaskContext]) -> bool:
    """Return whether this turn explicitly selected any knowledge source."""
    explicit_types = {
        ContextType.KNOWLEDGE_BASE.value,
        ContextType.SELECTED_DOCUMENTS.value,
        ContextType.EXTERNAL_KNOWLEDGE.value,
    }
    return any(context.context_type in explicit_types for context in contexts)


def _explicit_context_keys(
    contexts: Sequence[SubtaskContext],
) -> set[tuple[str, str]]:
    """Return source identities explicitly addressed by this turn."""
    keys: set[tuple[str, str]] = set()
    for context in contexts:
        context_type = context.context_type
        data = context.type_data
        if not isinstance(data, dict):
            continue
        if context_type in {
            ContextType.KNOWLEDGE_BASE.value,
            ContextType.SELECTED_DOCUMENTS.value,
        }:
            kb_id = _current_wegent_kb_id(str(context_type), data)
            if kb_id is not None:
                keys.add(("wegent", str(kb_id)))
            continue
        if context_type != ContextType.EXTERNAL_KNOWLEDGE.value:
            continue
        provider = str(data.get("provider") or "").strip().lower()
        kb_id = str(data.get("id") or "").strip()
        if provider and kb_id:
            keys.add((provider, kb_id))
    return keys


def _build_current_explicit_refs(
    db: "Session",
    *,
    current_contexts: Sequence[SubtaskContext],
) -> list[SelectedKnowledgeRef]:
    ready_contexts = [
        context
        for context in current_contexts
        if context.status == ContextStatus.READY.value
    ]
    wegent_refs = _build_current_wegent_refs(db, ready_contexts)
    return [
        *wegent_refs,
        *_build_external_refs_from_values(_current_external_values(ready_contexts)),
    ]


def _current_external_values(
    contexts: Sequence[SubtaskContext],
) -> list[dict[str, Any]]:
    return [
        {
            **context.type_data,
            "name": context.type_data.get("name") or context.name,
        }
        for context in contexts
        if context.status == ContextStatus.READY.value
        and context.context_type == ContextType.EXTERNAL_KNOWLEDGE.value
        and isinstance(context.type_data, dict)
    ]


def _build_current_wegent_refs(
    db: "Session",
    contexts: Sequence[SubtaskContext],
) -> list[SelectedKnowledgeRef]:
    refs: list[SelectedKnowledgeRef] = []
    for context in contexts:
        context_type = str(context.context_type or "")
        if context_type not in {
            ContextType.KNOWLEDGE_BASE.value,
            ContextType.SELECTED_DOCUMENTS.value,
        }:
            continue
        data = context.type_data
        if not isinstance(data, dict):
            continue
        kb_id = _current_wegent_kb_id(context_type, data)
        if kb_id is None:
            continue
        folder_ids = (
            _int_values(data.get("folder_ids"))
            if context_type == ContextType.KNOWLEDGE_BASE.value
            else []
        )
        document_ids = _int_values(data.get("document_ids"))
        scope_restricted = bool(data.get("scope_restricted")) or bool(
            folder_ids or document_ids
        )
        if scope_restricted and not (folder_ids or document_ids):
            continue
        resources = (
            _load_wegent_resources(
                db,
                kb_id,
                folder_ids,
                document_ids,
            )
            if scope_restricted
            else ()
        )
        refs.append(
            SelectedKnowledgeRef(
                provider="wegent",
                knowledge_base_id=str(kb_id),
                knowledge_base_name=(
                    ""
                    if context_type == ContextType.SELECTED_DOCUMENTS.value
                    else str(context.name or kb_id)
                ),
                resources=resources,
            )
        )
    return refs


def _current_wegent_kb_id(context_type: str, data: dict[str, Any]) -> int | None:
    key = (
        "knowledge_id"
        if context_type == ContextType.KNOWLEDGE_BASE.value
        else "knowledge_base_id"
    )
    values = _int_values([data.get(key)])
    return values[0] if values else None


def _build_wegent_refs(
    db: "Session",
    request: "ExecutionRequest",
    task: "TaskResource",
) -> list[SelectedKnowledgeRef]:
    selected_ids = _int_values(request.knowledge_base_ids)
    return _build_wegent_refs_for_ids(
        db,
        task,
        selected_ids,
        request_scopes=request.knowledge_base_scopes,
        prefer_request_scope=_is_knowledge_workbench_task(
            task.json if isinstance(task.json, dict) else {}
        ),
    )


def _build_wegent_refs_for_ids(
    db: "Session",
    task: "TaskResource",
    selected_ids: Iterable[Any],
    *,
    request_scopes: Iterable[Any] = (),
    prefer_request_scope: bool = False,
) -> list[SelectedKnowledgeRef]:
    selected_ids = set(_int_values(list(selected_ids)))
    if not selected_ids:
        return []

    from app.models.kind import Kind
    from app.services.knowledge.retrieval_capabilities import (
        derive_retrieval_capabilities,
    )

    capabilities_by_kb_id = {
        kind.id: derive_retrieval_capabilities(
            ((kind.json or {}).get("spec") or {}).get("retrievalConfig")
        )
        for kind in db.query(Kind).filter(Kind.id.in_(selected_ids)).all()
    }

    task_json: dict[str, Any] = task.json if isinstance(task.json, dict) else {}
    raw_spec = task_json.get("spec")
    spec: dict[str, Any] = raw_spec if isinstance(raw_spec, dict) else {}
    kb_refs = _index_refs_by_integer_id(spec.get("knowledgeBaseRefs"))
    scope_refs = _index_refs_by_integer_id(spec.get("knowledgeBaseScopes"))
    result: list[SelectedKnowledgeRef] = []
    for kb_id in sorted(selected_ids):
        scope = scope_refs.get(kb_id) or {}
        kb_name = str(scope.get("name") or kb_refs.get(kb_id, {}).get("name") or kb_id)
        (
            scope_restricted,
            folder_ids,
            document_ids,
        ) = _resolve_wegent_scope(
            kb_id,
            scope,
            request_scopes=request_scopes,
            prefer_request_scope=prefer_request_scope,
        )
        if not scope_restricted:
            result.append(
                SelectedKnowledgeRef(
                    provider="wegent",
                    knowledge_base_id=str(kb_id),
                    knowledge_base_name=kb_name,
                    retrieval_capabilities=capabilities_by_kb_id.get(kb_id, {}),
                )
            )
            continue
        if not (folder_ids or document_ids):
            continue

        resources = _load_wegent_resources(
            db,
            kb_id,
            folder_ids,
            document_ids,
        )
        result.append(
            SelectedKnowledgeRef(
                provider="wegent",
                knowledge_base_id=str(kb_id),
                knowledge_base_name=kb_name,
                resources=resources,
                retrieval_capabilities=capabilities_by_kb_id.get(kb_id, {}),
            )
        )
    return result


def _load_wegent_resources(
    db: "Session",
    kb_id: int,
    folder_ids: list[int],
    document_ids: list[int],
) -> tuple[SelectedKnowledgeResource, ...]:
    folders = (
        {
            folder.id: folder.name
            for folder in db.query(KnowledgeFolder)
            .filter(
                KnowledgeFolder.kind_id == kb_id,
                KnowledgeFolder.id.in_(folder_ids),
            )
            .all()
        }
        if folder_ids
        else {}
    )
    documents = (
        {
            document.id: document.name
            for document in db.query(KnowledgeDocument)
            .filter(
                KnowledgeDocument.kind_id == kb_id,
                KnowledgeDocument.id.in_(document_ids),
            )
            .all()
        }
        if document_ids
        else {}
    )
    return tuple(
        [
            SelectedKnowledgeResource(
                scope_type=KnowledgeScopeType.FOLDER,
                resource_id=str(folder_id),
                resource_name=folders.get(folder_id, str(folder_id)),
            )
            for folder_id in folder_ids
        ]
        + [
            SelectedKnowledgeResource(
                scope_type=KnowledgeScopeType.DOCUMENT,
                resource_id=str(document_id),
                resource_name=documents.get(document_id, str(document_id)),
            )
            for document_id in document_ids
        ]
    )


def _resolve_wegent_scope(
    kb_id: int,
    persisted_scope: dict[str, Any],
    *,
    request_scopes: Iterable[Any],
    prefer_request_scope: bool,
) -> tuple[bool, list[int], list[int]]:
    if prefer_request_scope:
        for request_scope in request_scopes:
            if request_scope.knowledge_base_id != kb_id:
                continue
            return (
                request_scope.scope_restricted,
                [],
                _int_values(request_scope.document_ids),
            )

    folder_ids = _int_values(persisted_scope.get("folderIds"))
    return (
        bool(persisted_scope.get("scopeRestricted")),
        folder_ids,
        _int_values(persisted_scope.get("explicitDocumentIds")),
    )


def _is_knowledge_workbench_task(task_json: dict[str, Any]) -> bool:
    metadata = task_json.get("metadata")
    if not isinstance(metadata, dict):
        return False
    labels = metadata.get("labels")
    return isinstance(labels, dict) and labels.get("taskType") == "knowledge"


def _build_external_refs(request: "ExecutionRequest") -> list[SelectedKnowledgeRef]:
    return _build_external_refs_from_values(request.external_knowledge_refs or [])


def _build_external_refs_from_values(
    values: Iterable[Any],
) -> list[SelectedKnowledgeRef]:
    result: list[SelectedKnowledgeRef] = []
    for value in values:
        if not isinstance(value, dict):
            continue
        provider = str(value.get("provider") or "").strip().lower()
        kb_id = str(value.get("id") or "").strip()
        if provider not in PROVIDER_SKILLS or not kb_id:
            continue
        scope_type = str(value.get("target_type") or "knowledge_base")
        if scope_type not in {
            KnowledgeScopeType.KNOWLEDGE_BASE,
            KnowledgeScopeType.FOLDER,
            KnowledgeScopeType.DOCUMENT,
        }:
            continue
        resource_id = None
        if scope_type == KnowledgeScopeType.FOLDER:
            resource_id = value.get("node_id") or value.get("parent_id")
        elif scope_type == KnowledgeScopeType.DOCUMENT:
            resource_id = value.get("document_id") or value.get("node_id")
        if scope_type != KnowledgeScopeType.KNOWLEDGE_BASE and not resource_id:
            continue
        resources: tuple[SelectedKnowledgeResource, ...] = ()
        if scope_type != KnowledgeScopeType.KNOWLEDGE_BASE:
            resources = (
                SelectedKnowledgeResource(
                    scope_type=scope_type,
                    resource_id=(str(resource_id) if resource_id is not None else None),
                    resource_name=value.get("target_name"),
                    resource_url=value.get("resource_url"),
                ),
            )
        result.append(
            SelectedKnowledgeRef(
                provider=provider,
                knowledge_base_id=kb_id,
                knowledge_base_name=str(value.get("name") or kb_id),
                resources=resources,
            )
        )
    return result


def _validate_explicit_external_contexts(
    contexts: Sequence[SubtaskContext],
) -> None:
    """Reject explicit external selections that cannot be consumed completely."""
    for value in _current_external_values(contexts):
        provider = str(value.get("provider") or "").strip().lower()
        if provider not in PROVIDER_SKILLS:
            _raise_invalid_selection_error(
                f"Unsupported knowledge provider: {provider or '<missing>'}"
            )
        if not str(value.get("id") or "").strip():
            _raise_invalid_selection_error(
                "Invalid explicit knowledge source: missing id"
            )

        scope_type = str(value.get("target_type") or "knowledge_base")
        if scope_type not in {
            KnowledgeScopeType.KNOWLEDGE_BASE,
            KnowledgeScopeType.FOLDER,
            KnowledgeScopeType.DOCUMENT,
        }:
            _raise_invalid_selection_error(
                f"Invalid explicit knowledge source: unsupported target type "
                f"{scope_type}"
            )
        if scope_type == KnowledgeScopeType.FOLDER and not (
            value.get("node_id") or value.get("parent_id")
        ):
            _raise_invalid_selection_error(
                "Invalid explicit knowledge source: missing folder id"
            )
        if scope_type == KnowledgeScopeType.DOCUMENT and not (
            value.get("document_id") or value.get("node_id")
        ):
            _raise_invalid_selection_error(
                "Invalid explicit knowledge source: missing document id"
            )


def validate_explicit_knowledge_contexts(
    contexts: Sequence[SubtaskContext],
) -> None:
    """Reject explicit knowledge selections that are not ready or identifiable."""
    explicit_types = {
        ContextType.KNOWLEDGE_BASE.value,
        ContextType.SELECTED_DOCUMENTS.value,
        ContextType.EXTERNAL_KNOWLEDGE.value,
    }
    for context in contexts:
        context_type = context.context_type
        if context_type not in explicit_types:
            continue
        status = context.status
        if status != ContextStatus.READY.value:
            _raise_invalid_selection_error(
                f"Selected knowledge source is not ready: {status or '<missing>'}"
            )
        if context_type == ContextType.EXTERNAL_KNOWLEDGE.value:
            continue
        data = context.type_data
        if (
            not isinstance(data, dict)
            or _current_wegent_kb_id(str(context_type), data) is None
        ):
            _raise_invalid_selection_error(
                "Invalid explicit Wegent knowledge source: missing or invalid "
                "knowledge base id"
            )


def _index_refs_by_integer_id(values: Any) -> dict[int, dict[str, Any]]:
    """Index valid reference mappings without trusting persisted identifiers."""
    result: dict[int, dict[str, Any]] = {}
    for value in values if isinstance(values, list) else []:
        if not isinstance(value, dict):
            continue
        identifiers = _int_values([value.get("id")])
        if identifiers:
            result[identifiers[0]] = value
    return result


def _int_values(values: Any) -> list[int]:
    result: list[int] = []
    for value in values if isinstance(values, list) else []:
        if isinstance(value, bool):
            continue
        try:
            normalized = int(value)
        except (TypeError, ValueError):
            continue
        if normalized <= 0:
            continue
        if normalized not in result:
            result.append(normalized)
    return result


def _positive_int(value: Any) -> int | None:
    values = _int_values([value])
    return values[0] if values else None


def _append_unique(values: list, value: str) -> None:
    if value not in values:
        values.append(value)
