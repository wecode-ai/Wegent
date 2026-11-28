# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Authorized native knowledge base discovery for web and MCP."""

from dataclasses import dataclass
from typing import Literal

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.knowledge import KnowledgeDocument
from app.models.namespace import Namespace
from app.schemas.knowledge import (
    KnowledgeBaseType,
    KnowledgeCatalogItem,
    KnowledgeCatalogResponse,
    ResourceScope,
)
from app.services.knowledge.knowledge_visibility_query import (
    apply_direct_access_filter,
    build_direct_access_query_context,
    build_knowledge_base_visibility_query,
    filter_knowledge_bases_for_agent_group,
    knowledge_base_json_text,
)
from app.services.knowledge.namespace_utils import (
    PERSONAL_NAMESPACE,
    NamespaceLevel,
    classify_namespace_level,
    load_active_namespace_map,
)

KnowledgeCategory = Literal["all", "document", "code"]
KnowledgeCatalogSort = Literal["created", "updated", "name", "group"]


@dataclass(frozen=True)
class KnowledgeCatalogFilters:
    scope: ResourceScope = ResourceScope.ALL
    group_name: str | None = None
    keyword: str | None = None
    owner_user_ids: tuple[int, ...] = ()
    category: KnowledgeCategory = "all"
    include_code: bool = True
    space_level: NamespaceLevel | None = None
    space_namespace: str | None = None
    binding_group: str | None = None
    candidate_ids: tuple[int, ...] = ()
    sort_by: KnowledgeCatalogSort = "created"
    ascending: bool = False
    offset: int = 0
    limit: int = 50


@dataclass
class KnowledgeCatalogPage:
    items: list[Kind]
    total: int
    space_counts: dict[str, int]


def _apply_catalog_filters(db: Session, query, filters: KnowledgeCatalogFilters):
    if filters.candidate_ids:
        query = query.filter(Kind.id.in_(filters.candidate_ids))
    if filters.owner_user_ids:
        query = query.filter(Kind.user_id.in_(filters.owner_user_ids))
    keyword = (filters.keyword or "").strip().lower()
    if keyword:
        # Use a portable escape character and match SQL wildcards literally.
        pattern = keyword.replace("!", "!!").replace("%", "!%").replace("_", "!_")
        name = knowledge_base_json_text(db, "$.spec.name")
        query = query.filter(func.lower(name).like(f"%{pattern}%", escape="!"))
    code = knowledge_base_json_text(db, "$.spec.kbType") == (
        KnowledgeBaseType.CODE_WIKI.value
    )
    if filters.category == "code":
        query = query.filter(code) if filters.include_code else query.filter(False)
    elif filters.category == "document" or not filters.include_code:
        query = query.filter(~code)
    return query


def _apply_space_filter(query, filters, organization_names):
    if filters.space_namespace is not None:
        query = query.filter(Kind.namespace == filters.space_namespace)
    if filters.space_level == "personal":
        return query.filter(Kind.namespace == PERSONAL_NAMESPACE)
    if filters.space_level == "organization":
        return query.filter(Kind.namespace.in_(organization_names))
    if filters.space_level == "group":
        return query.filter(
            Kind.namespace != PERSONAL_NAMESPACE,
            Kind.namespace.not_in(organization_names),
        )
    return query


def _sort_catalog(db: Session, query, filters: KnowledgeCatalogFilters):
    if filters.sort_by == "group":
        display_name = (
            select(
                func.coalesce(func.nullif(Namespace.display_name, ""), Namespace.name)
            )
            .where(Namespace.name == Kind.namespace, Namespace.is_active.is_(True))
            .correlate(Kind)
            .scalar_subquery()
        )
        order_by = func.lower(func.coalesce(display_name, Kind.namespace))
    elif filters.sort_by == "name":
        order_by = func.lower(knowledge_base_json_text(db, "$.spec.name"))
    elif filters.sort_by == "updated":
        order_by = Kind.updated_at
    else:
        order_by = Kind.created_at
    return query.order_by(
        order_by.asc() if filters.ascending else order_by.desc(), Kind.id.desc()
    )


def list_knowledge_catalog(
    db: Session,
    user_id: int,
    filters: KnowledgeCatalogFilters,
    *,
    include_space_counts: bool = False,
) -> KnowledgeCatalogPage:
    """Search the direct-access catalog, counting and paging unique native IDs."""
    context = build_direct_access_query_context(db, user_id)
    query = build_knowledge_base_visibility_query(
        db,
        user_id=user_id,
        scope=filters.scope,
        group_name=filters.group_name,
        permission_context=context,
    )
    if query is None:
        return KnowledgeCatalogPage([], 0, {})

    # Visibility predicates use EXISTS and the base query has one row per Kind.
    query = apply_direct_access_filter(db, query, user_id, context)
    if filters.binding_group:
        query = filter_knowledge_bases_for_agent_group(
            db, query, context, filters.binding_group
        )
    query = _apply_catalog_filters(db, query, filters)
    space_counts = (
        dict(
            query.with_entities(Kind.namespace, func.count())
            .group_by(Kind.namespace)
            .tuples()
            .all()
        )
        if include_space_counts
        else {}
    )
    query = _apply_space_filter(query, filters, context.organization_names)
    total = query.count()
    items = (
        _sort_catalog(db, query, filters)
        .offset(filters.offset)
        .limit(filters.limit)
        .all()
    )
    return KnowledgeCatalogPage(items, total, space_counts)


def get_document_counts(db: Session, knowledge_base_ids: list[int]) -> dict[int, int]:
    """Return total document counts for knowledge bases, including inactive docs."""
    if not knowledge_base_ids:
        return {}

    rows = (
        db.query(KnowledgeDocument.kind_id, func.count(KnowledgeDocument.id))
        .filter(KnowledgeDocument.kind_id.in_(knowledge_base_ids))
        .group_by(KnowledgeDocument.kind_id)
        .all()
    )
    return {knowledge_base_id: count for knowledge_base_id, count in rows}


def get_knowledge_catalog_response(
    db: Session, user_id: int, filters: KnowledgeCatalogFilters
) -> KnowledgeCatalogResponse:
    page = list_knowledge_catalog(db, user_id, filters, include_space_counts=True)
    namespaces = load_active_namespace_map(db, (kb.namespace for kb in page.items))
    counts = get_document_counts(db, [kb.id for kb in page.items])
    items = []
    for kb in page.items:
        namespace = namespaces.get(kb.namespace)
        level = classify_namespace_level(kb.namespace, namespace)
        spec = kb.json.get("spec") or {}
        items.append(
            KnowledgeCatalogItem(
                id=kb.id,
                name=spec.get("name") or "",
                description=spec.get("description"),
                user_id=kb.user_id,
                namespace=kb.namespace,
                namespace_level=level,
                namespace_display_name=(
                    namespace.display_name or namespace.name
                    if namespace
                    else kb.namespace if level != "personal" else None
                ),
                kb_type=spec.get("kbType") or KnowledgeBaseType.NOTEBOOK,
                document_count=counts.get(kb.id, 0),
                created_at=kb.created_at,
                updated_at=kb.updated_at,
            )
        )
    return KnowledgeCatalogResponse(
        items=items,
        total=page.total,
        returned_count=len(items),
        has_more=filters.offset + len(items) < page.total,
        offset=filters.offset,
        limit=filters.limit,
        space_counts=page.space_counts,
    )
