# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Render provider-neutral selected knowledge context for model runtimes."""

from __future__ import annotations

from dataclasses import asdict, is_dataclass
from html import escape
from typing import Any

from shared.models.knowledge import (
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
        "- Routing summaries and topics are metadata for choosing a source; they are not content evidence and must not be used to answer content questions.",
        "- For a content overview, use the provider's native listing capability.",
        "- For content questions, search or read evidence only within the sources above.",
        "- Use only the MCP tools belonging to each source's provider; do not translate the selection into a cross-provider query.",
        "- A source without resource children selects the whole knowledge base.",
        "- A folder resource selects the entire folder subtree; keep discovery within that subtree.",
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
    """Render provider-neutral failure and fallback guidance."""
    return [
        "- Treat a result as empty only when the provider call succeeded but returned no relevant evidence.",
        "- If access is denied, a call is rate-limited, or a tool fails, report that condition; you must not claim that the knowledge sources contain no relevant content, and do not retry after a rate limit.",
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
        "routing_summary": _optional_string(value.get("routing_summary")),
        "routing_topics": _normalize_topics(value.get("routing_topics")),
        "resources": resources,
        "retrieval_capabilities": _normalize_retrieval_capabilities(
            value.get("retrieval_capabilities")
        ),
    }


def _normalize_retrieval_capabilities(value: Any) -> dict[str, Any]:
    """Keep only the safe, derived capability summary in provider prompts."""
    if not isinstance(value, dict):
        return {}
    mode = value.get("retrieval_mode")
    if not isinstance(mode, str) or mode not in {"vector", "keyword", "hybrid"}:
        return {}
    return {
        "retrieval_mode": mode,
        "semantic_query": value.get("semantic_query") is True,
        "keywords": value.get("keywords") is True,
        "phrases": value.get("phrases") is True,
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
        "routing_summary": ref["routing_summary"],
        "routing_topics": ", ".join(ref["routing_topics"]),
    }
    capabilities = ref["retrieval_capabilities"]
    if capabilities:
        attributes["retrieval_mode"] = capabilities["retrieval_mode"]
        search_hints = ",".join(
            name
            for name in ("semantic_query", "keywords", "phrases")
            if capabilities[name]
        )
        if search_hints:
            attributes["search_hints"] = search_hints
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


def _normalize_topics(value: Any) -> tuple[str, ...]:
    if not isinstance(value, (list, tuple)):
        return ()
    return tuple(
        topic for item in value if (topic := _optional_string(item)) is not None
    )
