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
    """Merge task refs while letting this turn override the same source."""
    merged_refs = list(_merge_refs(task_refs))
    indexes = {_ref_key(ref): index for index, ref in enumerate(merged_refs)}
    normalized_explicit_refs = _merge_refs(explicit_refs)
    for explicit_ref in normalized_explicit_refs:
        key = _ref_key(explicit_ref)
        index = indexes.get(key)
        if index is None:
            indexes[key] = len(merged_refs)
            merged_refs.append(explicit_ref)
            continue
        merged_refs[index] = _overlay_explicit_ref(merged_refs[index], explicit_ref)
    return SelectedKnowledgeContext(
        refs=tuple(merged_refs),
        evidence_required=bool(normalized_explicit_refs),
    )


def _ref_key(ref: SelectedKnowledgeRef) -> tuple[str, str]:
    return ref.provider, ref.knowledge_base_id


def _overlay_explicit_ref(
    task_ref: SelectedKnowledgeRef,
    explicit_ref: SelectedKnowledgeRef,
) -> SelectedKnowledgeRef:
    """Keep task metadata while the explicit ref owns the effective scope."""
    return SelectedKnowledgeRef(
        provider=explicit_ref.provider,
        knowledge_base_id=explicit_ref.knowledge_base_id,
        knowledge_base_name=(
            explicit_ref.knowledge_base_name or task_ref.knowledge_base_name
        ),
        resources=explicit_ref.resources,
        routing_summary=explicit_ref.routing_summary or task_ref.routing_summary,
        routing_topics=_merge_topics(
            explicit_ref.routing_topics,
            task_ref.routing_topics,
        ),
        retrieval_capabilities=(
            explicit_ref.retrieval_capabilities or task_ref.retrieval_capabilities
        ),
    )


def _merge_refs(
    refs: Iterable[SelectedKnowledgeRef],
) -> tuple[SelectedKnowledgeRef, ...]:
    merged: dict[tuple[str, str], SelectedKnowledgeRef] = {}
    for ref in refs:
        key = _ref_key(ref)
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
            routing_summary=current.routing_summary or ref.routing_summary,
            routing_topics=_merge_topics(
                current.routing_topics,
                ref.routing_topics,
            ),
            retrieval_capabilities=(
                current.retrieval_capabilities or ref.retrieval_capabilities
            ),
        )
    return tuple(merged.values())


def _merge_topics(*topic_groups: Iterable[str]) -> tuple[str, ...]:
    return tuple(dict.fromkeys(topic for group in topic_groups for topic in group))


def _merge_resources(
    *resource_groups: Iterable[SelectedKnowledgeResource],
) -> tuple[SelectedKnowledgeResource, ...]:
    indexes: dict[tuple[str, str | None], int] = {}
    resources: list[SelectedKnowledgeResource] = []
    for group in resource_groups:
        for resource in group:
            key = (resource.scope_type, resource.resource_id)
            if key in indexes:
                continue
            indexes[key] = len(resources)
            resources.append(resource)
    return tuple(resources)
