# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Render provider-neutral selected knowledge context for model runtimes."""

from __future__ import annotations

from dataclasses import asdict, is_dataclass
from html import escape
from typing import Any, Iterable

from shared.models.knowledge import KnowledgeScopeType, SelectedKnowledgeRef


def render_selected_knowledge_prompt(
    refs: Iterable[SelectedKnowledgeRef | dict[str, Any]],
) -> str:
    """Render one stable prompt shared by Chat Shell and coding runtimes."""
    normalized = [_normalize_ref(ref) for ref in refs]
    normalized = [ref for ref in normalized if ref is not None]
    if not normalized:
        return ""

    source_lines = ["<selected_knowledge_sources>"]
    for ref in normalized:
        source_lines.extend(_render_source(ref))
    source_lines.append("</selected_knowledge_sources>")

    guidance = [
        "<selected_knowledge_guidance>",
        "- These sources were explicitly selected by the user. Prefer them for the current request.",
        "- Use only the MCP tools belonging to each source's provider; do not translate the selection into a cross-provider query.",
        "- A source without resource children selects the whole knowledge base.",
        "- For a folder resource, keep discovery within that folder and its descendants when the provider supports hierarchy.",
        "- For a document resource, read that exact document before using broader search.",
        "- Use knowledge_base_id and resource_id as provider-native tool arguments; names, paths, and URLs are context only.",
        "- If the selected range is insufficient, explain why before broadening it.",
        "- A selected scope guides retrieval priority; the provider remains the authority for access control.",
        "- If a provider cannot perform a scoped search, traverse its native hierarchy or read the exact resource instead of using an unscoped global search.",
        "</selected_knowledge_guidance>",
    ]
    return "\n".join([*source_lines, *guidance])


def _normalize_ref(
    ref: SelectedKnowledgeRef | dict[str, Any],
) -> dict[str, Any] | None:
    if is_dataclass(ref):
        value = asdict(ref)
    elif isinstance(ref, dict):
        value = ref
    else:
        return None

    provider = str(value.get("provider") or "").strip()
    knowledge_base_id = str(value.get("knowledge_base_id") or "").strip()
    if not provider or not knowledge_base_id:
        return None
    raw_resources = value.get("resources") or ()
    if not isinstance(raw_resources, (list, tuple)):
        return None
    resources = [
        normalized
        for resource in raw_resources
        if (normalized := _normalize_resource(resource)) is not None
    ]
    if raw_resources and not resources:
        return None
    return {
        "provider": provider,
        "knowledge_base_id": knowledge_base_id,
        "knowledge_base_name": str(value.get("knowledge_base_name") or "").strip(),
        "resources": resources,
    }


def _normalize_resource(value: Any) -> dict[str, str | None] | None:
    if not isinstance(value, dict):
        return None
    scope_type = str(value.get("scope_type") or "").strip()
    resource_id = _optional_string(value.get("resource_id"))
    if scope_type not in {KnowledgeScopeType.FOLDER, KnowledgeScopeType.DOCUMENT}:
        return None
    if resource_id is None:
        return None
    return {
        "scope_type": scope_type,
        "resource_id": resource_id,
        "resource_name": _optional_string(value.get("resource_name")),
        "resource_path": _optional_string(value.get("resource_path")),
        "resource_url": _optional_string(value.get("resource_url")),
    }


def _render_source(ref: dict[str, Any]) -> list[str]:
    attributes = {
        "provider": ref["provider"],
        "knowledge_base_id": ref["knowledge_base_id"],
        "knowledge_base_name": ref["knowledge_base_name"],
    }
    rendered_source = _render_attributes(attributes)
    resources = ref["resources"]
    if not resources:
        return [f"  <source {rendered_source} />"]
    lines = [f"  <source {rendered_source}>"]
    lines.extend(
        f"    <resource {_render_attributes(resource)} />" for resource in resources
    )
    lines.append("  </source>")
    return lines


def _render_attributes(attributes: dict[str, Any]) -> str:
    return " ".join(
        f'{name}="{escape(str(value), quote=True)}"'
        for name, value in attributes.items()
        if value not in (None, "")
    )


def _optional_string(value: Any) -> str | None:
    text = str(value or "").strip()
    return text or None
