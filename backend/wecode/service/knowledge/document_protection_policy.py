# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Company knowledge document protection policy."""

from sqlalchemy.orm import Session

from app.models.kind import Kind
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
