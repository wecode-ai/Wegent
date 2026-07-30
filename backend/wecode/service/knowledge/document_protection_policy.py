# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Company knowledge document protection policy."""

from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.knowledge import KnowledgeDocument
from app.services.knowledge.namespace_utils import load_active_namespace_map


def is_protected_knowledge_base(db: Session, knowledge_base_id: int) -> bool:
    kb = (
        db.query(Kind)
        .filter(
            Kind.id == knowledge_base_id,
            Kind.kind == "KnowledgeBase",
            Kind.is_active.is_(True),
        )
        .first()
    )
    if kb is None:
        return False
    namespace = load_active_namespace_map(db, [kb.namespace]).get(kb.namespace)
    return bool(namespace and namespace.level == "organization")


def is_protected_attachment(db: Session, attachment_id: int) -> bool:
    knowledge_base_ids = [
        row[0]
        for row in db.query(KnowledgeDocument.kind_id)
        .filter(KnowledgeDocument.attachment_id == attachment_id)
        .distinct()
        .all()
    ]
    if not knowledge_base_ids:
        return False

    knowledge_bases = (
        db.query(Kind)
        .filter(
            Kind.id.in_(knowledge_base_ids),
            Kind.kind == "KnowledgeBase",
            Kind.is_active.is_(True),
        )
        .all()
    )
    namespace_map = load_active_namespace_map(
        db, [knowledge_base.namespace for knowledge_base in knowledge_bases]
    )
    return any(
        namespace_map.get(knowledge_base.namespace)
        and namespace_map[knowledge_base.namespace].level == "organization"
        for knowledge_base in knowledge_bases
    )
