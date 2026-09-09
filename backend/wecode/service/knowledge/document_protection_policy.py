# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Company knowledge document protection policy."""

from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.services.knowledge.document_download_policy import (
    is_default_original_download_allowed,
)
from app.services.knowledge.namespace_utils import load_active_namespace_map


def is_internal_original_download_allowed(
    db: Session,
    knowledge_base: Kind,
) -> bool:
    """Apply the internal default only when an administrator did not set it.

    The open-source default remains allow. Internal organization/T2 detection is
    deliberately confined to this module so it cannot leak into core policy.
    """
    spec = knowledge_base.json.get("spec", {}) if knowledge_base.json else {}
    if spec.get("allowDocumentDownload") is not None:
        return is_default_original_download_allowed(db, knowledge_base)

    namespace = load_active_namespace_map(db, [knowledge_base.namespace]).get(
        knowledge_base.namespace
    )
    return not bool(namespace and namespace.level == "organization")


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
    return not is_internal_original_download_allowed(db, kb)
