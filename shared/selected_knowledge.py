# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Resolve provider-native knowledge routing for one execution request."""

from __future__ import annotations

from collections.abc import Iterable

from shared.models.knowledge import (
    SelectedKnowledgeContext,
    SelectedKnowledgeRef,
    SelectedKnowledgeResource,
)


def resolve_selected_knowledge_context(
    task_refs: Iterable[SelectedKnowledgeRef],
    explicit_refs: Iterable[SelectedKnowledgeRef],
) -> SelectedKnowledgeContext:
    """Prefer this turn's explicit refs, otherwise use task-level refs."""
    normalized_explicit_refs = tuple(explicit_refs)
    source_refs = normalized_explicit_refs or tuple(task_refs)
    return SelectedKnowledgeContext(
        refs=_merge_refs(source_refs),
        evidence_required=bool(normalized_explicit_refs),
    )


def _merge_refs(
    refs: Iterable[SelectedKnowledgeRef],
) -> tuple[SelectedKnowledgeRef, ...]:
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
        merged[key] = SelectedKnowledgeRef(
            provider=current.provider,
            knowledge_base_id=current.knowledge_base_id,
            knowledge_base_name=current.knowledge_base_name,
            resources=_merge_resources(current.resources, ref.resources),
        )
    return tuple(merged.values())


def _merge_resources(
    *resource_groups: Iterable[SelectedKnowledgeResource],
) -> tuple[SelectedKnowledgeResource, ...]:
    seen: set[tuple[str, str | None]] = set()
    resources: list[SelectedKnowledgeResource] = []
    for group in resource_groups:
        for resource in group:
            key = (resource.scope_type, resource.resource_id)
            if key in seen:
                continue
            seen.add(key)
            resources.append(resource)
    return tuple(resources)
