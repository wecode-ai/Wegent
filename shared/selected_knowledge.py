# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Resolve provider-native knowledge routing for one execution request."""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import replace

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
    indexes: dict[tuple[str, str | None], int] = {}
    resources: list[SelectedKnowledgeResource] = []
    for group in resource_groups:
        for resource in group:
            key = (resource.scope_type, resource.resource_id)
            index = indexes.get(key)
            if index is not None:
                resources[index] = _merge_resource(resources[index], resource)
                continue
            indexes[key] = len(resources)
            resources.append(resource)
    return tuple(resources)


def _merge_resource(
    current: SelectedKnowledgeResource,
    incoming: SelectedKnowledgeResource,
) -> SelectedKnowledgeResource:
    """Merge duplicate resource scopes using union semantics."""
    if current.scope_type != "folder":
        return current
    include_descendants = _merge_include_descendants(
        current.include_descendants,
        incoming.include_descendants,
    )
    return replace(current, include_descendants=include_descendants)


def _merge_include_descendants(
    current: bool | None,
    incoming: bool | None,
) -> bool | None:
    if current is True or incoming is True:
        return True
    if current is False and incoming is False:
        return False
    return None
