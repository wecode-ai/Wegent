# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Validation helpers for public admin-managed resources."""

from typing import Optional

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.services.knowledge.namespace_utils import is_organization_namespace


def validate_public_default_knowledge_base_refs(
    db: Session, refs: Optional[list[dict]]
) -> None:
    """Ensure public resources only bind organization knowledge bases."""
    if not refs:
        return

    invalid_names: list[str] = []
    for ref in refs:
        kb_id = ref.get("id") if isinstance(ref, dict) else None
        kb_name = ref.get("name") if isinstance(ref, dict) else str(ref)
        kb = (
            db.query(Kind)
            .filter(
                Kind.id == kb_id,
                Kind.kind == "KnowledgeBase",
                Kind.is_active.is_(True),
            )
            .first()
            if kb_id
            else None
        )
        if not kb or not is_organization_namespace(db, kb.namespace):
            invalid_names.append(kb_name or str(kb_id))

    if invalid_names:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                "Public resources can only bind organization knowledge bases: "
                + ", ".join(invalid_names)
            ),
        )


def validate_public_ghost_default_knowledge_bases(
    db: Session, ghost_json: Optional[dict]
) -> None:
    """Validate default KB refs embedded in a public Ghost JSON document."""
    if not ghost_json or not isinstance(ghost_json, dict):
        return
    spec = ghost_json.get("spec", {})
    if isinstance(spec, dict):
        validate_public_default_knowledge_base_refs(
            db, spec.get("defaultKnowledgeBaseRefs")
        )
