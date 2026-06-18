# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Utilities for maintaining default context refs and legacy KB refs."""

from typing import Any, Optional

from pydantic import TypeAdapter

from app.schemas.kind import (
    DefaultContextRef,
    DefaultKnowledgeBaseContextRef,
    KnowledgeBaseDefaultRef,
)

DEFAULT_CONTEXT_REF_ADAPTER = TypeAdapter(DefaultContextRef)


def dump_default_context_refs(refs: Optional[list[DefaultContextRef]]) -> list[dict]:
    """Serialize default context refs for Ghost JSON."""
    return [ref.model_dump(mode="json") for ref in refs or []]


def parse_default_context_refs(refs: list[dict]) -> list[DefaultContextRef]:
    """Validate raw default context refs before assigning to Ghost spec."""
    return [DEFAULT_CONTEXT_REF_ADAPTER.validate_python(ref) for ref in refs]


def knowledge_refs_to_default_context_refs(
    refs: Optional[list[KnowledgeBaseDefaultRef]],
) -> list[DefaultContextRef]:
    """Convert legacy default KB refs into unified default context refs."""
    if not refs:
        return []
    return [
        DefaultKnowledgeBaseContextRef(
            type="knowledge_base",
            id=ref.id,
            name=ref.name,
        )
        for ref in refs
    ]


def raw_knowledge_refs_to_default_context_ref_dicts(
    refs: Optional[list[dict[str, Any]]],
) -> list[dict[str, Any]]:
    """Convert raw legacy KB ref dictionaries into raw default context ref dictionaries."""
    return [
        {"type": "knowledge_base", **ref} for ref in refs or [] if isinstance(ref, dict)
    ]


def extract_default_knowledge_base_refs(
    refs: Optional[list[DefaultContextRef]],
) -> list[KnowledgeBaseDefaultRef]:
    """Extract typed legacy KB refs from the unified default context collection."""
    result: list[KnowledgeBaseDefaultRef] = []
    for ref in refs or []:
        if ref.type != "knowledge_base":
            continue
        result.append(
            KnowledgeBaseDefaultRef(
                id=ref.id,
                name=ref.name,
            )
        )
    return result


def extract_default_knowledge_base_ref_dicts(
    refs: Optional[list[DefaultContextRef]],
) -> list[dict[str, Any]]:
    """Extract raw legacy KB ref dictionaries from unified default context refs."""
    result: list[dict[str, Any]] = []
    for ref in refs or []:
        if ref.type != "knowledge_base":
            continue
        item = {"id": ref.id, "name": ref.name}
        if ref.document_count is not None:
            item["document_count"] = ref.document_count
        result.append(item)
    return result


def merge_legacy_knowledge_refs(
    existing_refs: Optional[list[DefaultContextRef]],
    legacy_refs: Optional[list[KnowledgeBaseDefaultRef]],
) -> list[DefaultContextRef]:
    """Replace only KB refs while preserving non-KB default contexts."""
    non_kb_refs = [ref for ref in existing_refs or [] if ref.type != "knowledge_base"]
    return [
        *non_kb_refs,
        *knowledge_refs_to_default_context_refs(legacy_refs),
    ]


def merge_raw_legacy_knowledge_refs(
    existing_context_refs: Optional[list[dict[str, Any]]],
    legacy_refs: Optional[list[dict[str, Any]]],
) -> list[dict[str, Any]]:
    """Replace only raw KB refs while preserving non-KB raw default contexts."""
    non_kb_refs = [
        ref
        for ref in existing_context_refs or []
        if isinstance(ref, dict) and ref.get("type") != "knowledge_base"
    ]
    return [
        *non_kb_refs,
        *raw_knowledge_refs_to_default_context_ref_dicts(legacy_refs),
    ]
