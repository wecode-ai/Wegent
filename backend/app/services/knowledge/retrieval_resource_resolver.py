# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Resolve caller-visible retrieval resources for the knowledge module.

The knowledge module composes and validates a retrieval configuration but never
queries a product table. This module is the Wegent adapter's lookup: it reports
what the existing resolution would actually load, so the module can check a
selected reference against the record its owner is authorized to use.

It adds no access rule of its own. Retrievers go through the existing retriever
service, which owns the group permission check and the public fallback; models go
through caller-visible reference resolution, with membership checked only for
the receiving namespace. Approved references authorize their source records.
"""

from __future__ import annotations

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.schemas.kind import resolve_model_category
from app.services.adapters.retriever_kinds import retriever_kinds_service
from app.services.group_permission import check_group_permission
from app.services.knowledge.namespace_utils import is_organization_namespace
from shared.db.capability_reference import resolve_model_kind
from shared.knowledge_module import (
    MODEL_RESOURCE_KIND,
    RETRIEVER_RESOURCE_KIND,
    RetrievalResource,
)


def resolve_retriever_resource(
    db: Session, *, user_id: int, name: str, namespace: str = "default"
) -> RetrievalResource | None:
    """Resolve a retriever reference: personal/group, referenced, then public.

    Returns ``None`` when the reference cannot be used -- it does not exist, its
    group is not accessible, or its group is not one the caller belongs to.
    """
    try:
        retriever = retriever_kinds_service.get_retriever(
            db, user_id=user_id, name=name, namespace=namespace or "default"
        )
    except HTTPException:
        return None
    if retriever.metadata.name != name:
        return None
    return RetrievalResource(
        name=retriever.metadata.name,
        namespace=retriever.metadata.namespace or "default",
        kind=RETRIEVER_RESOURCE_KIND,
    )


def resolve_embedding_model_resource(
    db: Session, *, user_id: int, name: str, namespace: str = "default"
) -> RetrievalResource | None:
    """Resolve an embedding model reference the way the runtime loads it.

    The resolved record carries the model's real category, so a model that is
    not an embedding model is reported as such instead of being silently
    accepted for the embedding slot. Approved references retain the receiving
    namespace as their logical identity, without requiring source membership.
    """
    requested_namespace = namespace or "default"
    if not _caller_can_use_namespace(db, user_id, requested_namespace):
        return None
    kind = resolve_model_kind(
        db, name=name, namespace=requested_namespace, user_id=user_id
    )
    if kind is None:
        return None
    spec = (kind.json or {}).get("spec", {})
    return RetrievalResource(
        name=kind.name,
        namespace=requested_namespace,
        kind=MODEL_RESOURCE_KIND,
        category=resolve_model_category(spec),
    )


def _caller_can_use_namespace(db: Session, user_id: int, namespace: str) -> bool:
    """Whether the caller may use the resources a namespace owns.

    Mirrors the rule the retriever path already applies: the personal namespace
    belongs to its caller, organization namespaces are visible to everyone, and
    a group namespace requires at least the Reporter membership.
    """
    if namespace == "default" or is_organization_namespace(db, namespace):
        return True
    return check_group_permission(db, user_id, namespace, required_role="Reporter")
