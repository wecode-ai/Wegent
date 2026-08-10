# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Build the provider-neutral selected knowledge execution context."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any, NoReturn

from fastapi import HTTPException

from app.models.knowledge import KnowledgeDocument, KnowledgeFolder
from app.services.execution.skill_mcp import extract_skill_mcp_servers
from shared.models.knowledge import (
    KnowledgeScopeType,
    SelectedKnowledgeRef,
    SelectedKnowledgeResource,
)
from shared.prompts import render_selected_knowledge_prompt

if TYPE_CHECKING:
    from sqlalchemy.orm import Session

    from app.models.task import TaskResource
    from shared.models.execution import ExecutionRequest


PROVIDER_SKILLS = {
    "wegent": "wegent-knowledge",
    "dingtalk": "dingtalk-docs",
}
SUPPORTED_PROVIDER_NATIVE_SHELLS = {"Chat", "ClaudeCode"}


def register_provider_skill(provider_id: str, skill_name: str) -> None:
    """Register a deployment-specific provider Skill before execution."""
    PROVIDER_SKILLS[provider_id] = skill_name


def apply_selected_knowledge_context(
    db: "Session",
    request: "ExecutionRequest",
    task: "TaskResource",
) -> list[str]:
    """Attach the selected-knowledge prompt and deterministic provider skills."""
    refs = build_selected_knowledge_refs(db, request, task)
    if not refs:
        request.selected_knowledge_prompt = ""
        request.provider_native_knowledge = False
        return []

    shell_type = get_request_shell_type(request)
    if shell_type not in SUPPORTED_PROVIDER_NATIVE_SHELLS:
        request.selected_knowledge_prompt = ""
        request.provider_native_knowledge = False
        return []

    request.selected_knowledge_prompt = render_selected_knowledge_prompt(refs)
    request.provider_native_knowledge = False

    request.preload_skills = list(request.preload_skills or [])
    request.user_selected_skills = list(request.user_selected_skills or [])

    selected_skills: list[str] = []
    for ref in refs:
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
    """Activate provider-native access after every required MCP is available."""
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


def build_selected_knowledge_refs(
    db: "Session",
    request: "ExecutionRequest",
    task: "TaskResource",
) -> list[SelectedKnowledgeRef]:
    """Normalize internal task scopes and external refs without querying content."""
    refs = [*_build_wegent_refs(db, request, task), *_build_external_refs(request)]
    return _merge_selected_knowledge_refs(refs)


def _merge_selected_knowledge_refs(
    refs: list[SelectedKnowledgeRef],
) -> list[SelectedKnowledgeRef]:
    """Merge selections into one runtime ref per provider knowledge base."""
    merged: dict[tuple[str, str], SelectedKnowledgeRef] = {}
    for ref in refs:
        key = (ref.provider, ref.knowledge_base_id)
        current = merged.get(key)
        if current is None:
            merged[key] = ref
            continue
        if not current.resources:
            continue
        if not ref.resources:
            merged[key] = ref
            continue

        resources = [*current.resources, *ref.resources]
        seen_resources: set[tuple[str, str | None]] = set()
        unique_resources: list[SelectedKnowledgeResource] = []
        for resource in resources:
            resource_key = (resource.scope_type, resource.resource_id)
            if resource_key in seen_resources:
                continue
            seen_resources.add(resource_key)
            unique_resources.append(resource)
        merged[key] = SelectedKnowledgeRef(
            provider=current.provider,
            knowledge_base_id=current.knowledge_base_id,
            knowledge_base_name=current.knowledge_base_name,
            resources=tuple(unique_resources),
        )
    return list(merged.values())


def _build_wegent_refs(
    db: "Session",
    request: "ExecutionRequest",
    task: "TaskResource",
) -> list[SelectedKnowledgeRef]:
    selected_ids = set(_int_values(request.knowledge_base_ids))
    if not selected_ids:
        return []

    task_json = task.json if isinstance(task.json, dict) else {}
    spec = task_json.get("spec") if isinstance(task_json.get("spec"), dict) else {}
    kb_refs = {
        int(ref["id"]): ref
        for ref in spec.get("knowledgeBaseRefs") or []
        if isinstance(ref, dict) and ref.get("id") is not None
    }
    scope_refs = {
        int(ref["id"]): ref
        for ref in spec.get("knowledgeBaseScopes") or []
        if isinstance(ref, dict) and ref.get("id") is not None
    }

    result: list[SelectedKnowledgeRef] = []
    for kb_id in sorted(selected_ids):
        scope = scope_refs.get(kb_id) or {}
        kb_name = str(scope.get("name") or kb_refs.get(kb_id, {}).get("name") or kb_id)
        folder_ids = _int_values(scope.get("folderIds"))
        document_ids = _int_values(scope.get("explicitDocumentIds"))
        if not bool(scope.get("scopeRestricted")) or not (folder_ids or document_ids):
            result.append(
                SelectedKnowledgeRef(
                    provider="wegent",
                    knowledge_base_id=str(kb_id),
                    knowledge_base_name=kb_name,
                )
            )
            continue

        folders = {
            folder.id: folder.name
            for folder in db.query(KnowledgeFolder)
            .filter(
                KnowledgeFolder.kind_id == kb_id,
                KnowledgeFolder.id.in_(folder_ids),
            )
            .all()
        }
        documents = {
            document.id: document.name
            for document in db.query(KnowledgeDocument)
            .filter(
                KnowledgeDocument.kind_id == kb_id,
                KnowledgeDocument.id.in_(document_ids),
            )
            .all()
        }
        resources = tuple(
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
        result.append(
            SelectedKnowledgeRef(
                provider="wegent",
                knowledge_base_id=str(kb_id),
                knowledge_base_name=kb_name,
                resources=resources,
            )
        )
    return result


def _build_external_refs(request: "ExecutionRequest") -> list[SelectedKnowledgeRef]:
    result: list[SelectedKnowledgeRef] = []
    for value in request.external_knowledge_refs or []:
        if not isinstance(value, dict):
            continue
        provider = str(value.get("provider") or "").strip().lower()
        kb_id = str(value.get("id") or "").strip()
        if provider not in PROVIDER_SKILLS or not kb_id:
            continue
        scope_type = str(value.get("target_type") or "knowledge_base")
        resource_id = None
        if scope_type == KnowledgeScopeType.FOLDER:
            resource_id = value.get("node_id") or value.get("parent_id")
        elif scope_type == KnowledgeScopeType.DOCUMENT:
            resource_id = value.get("document_id") or value.get("node_id")
        resources = ()
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


def _int_values(values: Any) -> list[int]:
    result: list[int] = []
    for value in values if isinstance(values, list) else []:
        try:
            normalized = int(value)
        except (TypeError, ValueError):
            continue
        if normalized not in result:
            result.append(normalized)
    return result


def _append_unique(values: list, value: str) -> None:
    if value not in values:
        values.append(value)
