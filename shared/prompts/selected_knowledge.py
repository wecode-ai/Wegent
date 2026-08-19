# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Render provider-neutral selected knowledge context for model runtimes."""

from __future__ import annotations

from dataclasses import asdict, is_dataclass
from html import escape
from typing import Any

from shared.models.knowledge import (
    KnowledgeAccessOutcome,
    KnowledgeScopeType,
    SelectedKnowledgeContext,
    SelectedKnowledgeRef,
)


def render_selected_knowledge_prompt(
    context: SelectedKnowledgeContext,
) -> str:
    """Render one stable prompt shared by Chat Shell and coding runtimes."""
    normalized = [
        normalized_ref
        for ref in context.refs
        if (normalized_ref := _normalize_ref(ref)) is not None
    ]
    if not normalized:
        return ""

    source_lines = ["<selected_knowledge_sources>"]
    for ref in normalized:
        source_lines.extend(_render_source(ref))
    source_lines.append("</selected_knowledge_sources>")

    guidance = [
        "<selected_knowledge_guidance>",
        *_render_evidence_policy(context.evidence_required),
        "- First distinguish source metadata, content overview, content questions, and management requests.",
        "- For source metadata, answer from the source information above without retrieving content.",
        "- For a content overview, use the provider's native listing capability.",
        "- For content questions, search or read evidence only within the sources above.",
        "- Use only the MCP tools belonging to each source's provider; do not translate the selection into a cross-provider query.",
        "- A source without resource children selects the whole knowledge base.",
        "- For a folder resource, honor include_descendants exactly; when omitted, stay within the provider-native selected folder scope without broadening it.",
        "- For a document resource, read that exact document before using broader search.",
        "- Use knowledge_base_id and resource_id as provider-native tool arguments; names, paths, and URLs are context only.",
        "- Do not broaden to other knowledge sources unless the user explicitly authorizes it.",
        *_render_outcome_policy(),
        "- Cite the actual source when using knowledge content.",
        "- Create or update content only when the user explicitly requests a management action.",
        "- This scope guides model routing; the provider remains the authority for access control.",
        "- If a provider cannot perform a scoped search, traverse its native hierarchy or read the exact resource instead of using an unscoped global search.",
        "- If search is unavailable or unsupported for a selected source, use the provider's native listing and exact-read capabilities to gather evidence.",
        "- If search results are insufficient to support a precision-sensitive claim, read the relevant original document content before answering.",
        "</selected_knowledge_guidance>",
    ]
    return "\n".join([*source_lines, *guidance])


def _render_outcome_policy() -> list[str]:
    """Render the minimal provider-neutral failure and fallback contract."""
    return [
        "- Normalize provider outcomes by meaning before deciding what to do:",
        f"  - {KnowledgeAccessOutcome.UNSUPPORTED}: search is unavailable; use native listing and exact-read capabilities.",
        f"  - {KnowledgeAccessOutcome.DENIED}: access was refused; report the permission boundary and do not claim that no relevant content exists.",
        f"  - {KnowledgeAccessOutcome.RATE_LIMITED}: the provider rejected further calls; stop retrying and report the temporary limit.",
        f"  - {KnowledgeAccessOutcome.FAILED}: the tool call failed; report the failure and do not treat it as an empty result.",
        f"  - {KnowledgeAccessOutcome.EMPTY}: the call succeeded but returned no relevant evidence; apply the explicit or inherited evidence policy above.",
        "- On denied, rate_limited, or failed outcomes, you must not claim that the knowledge sources contain no relevant content.",
    ]


def _render_evidence_policy(evidence_required: bool) -> list[str]:
    if evidence_required:
        return [
            "- These sources were explicitly selected by the user for this request.",
            "- For content questions, you must obtain evidence from these sources before answering.",
            "- If there is no relevant evidence, say so; you must not use general knowledge to fill the gap.",
        ]
    return [
        "- These are inherited task sources. Prefer them for the current request.",
        "- For content questions, obtain evidence from these sources first.",
        "- If there is no relevant result, state that the knowledge sources had no relevant result; you may use general knowledge afterward.",
    ]


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


def _normalize_resource(value: Any) -> dict[str, str | bool | None] | None:
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
        "include_descendants": _optional_bool(value.get("include_descendants")),
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
        f'{name}="{escape(_attribute_text(value), quote=True)}"'
        for name, value in attributes.items()
        if value not in (None, "")
    )


def _attribute_text(value: Any) -> str:
    if isinstance(value, bool):
        return str(value).lower()
    return str(value)


def _optional_string(value: Any) -> str | None:
    text = str(value or "").strip()
    return text or None


def _optional_bool(value: Any) -> bool | None:
    return value if isinstance(value, bool) else None
