# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Shared external-department helpers for marketplace ACLs."""

import logging

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.services.external_entity_resolver import get_entity_resolver

ORG_DEPARTMENT_ENTITY_TYPE = "org_department"
logger = logging.getLogger(__name__)


def normalize_org_department_target(
    db: Session,
    *,
    entity_id: str,
    display_name: str,
    invalid_detail: str,
) -> tuple[str, str]:
    """Validate and normalize an ERP department selected by an authenticated user."""
    normalized_id = entity_id.strip()
    normalized_name = display_name.strip()
    resolver = get_entity_resolver(ORG_DEPARTMENT_ENTITY_TYPE)
    if (
        not normalized_id
        or not normalized_name
        or resolver is None
        or not resolver.validate_entity_id(db, normalized_id)
    ):
        raise HTTPException(status_code=422, detail=invalid_detail)

    resolved_name = resolver.get_display_name(db, normalized_id)
    return normalized_id, resolved_name or normalized_name


def get_org_department_resource_ids(
    db: Session,
    *,
    user_id: int,
    resource_type: str,
) -> set[int]:
    """Resolve all resources granted through ERP departments in one batch."""
    resolver = get_entity_resolver(ORG_DEPARTMENT_ENTITY_TYPE)
    if resolver is None:
        return set()
    try:
        return set(
            resolver.get_resource_ids_by_entity(
                db,
                user_id,
                ORG_DEPARTMENT_ENTITY_TYPE,
                resource_type=resource_type,
            )
        )
    except Exception:
        logger.exception(
            "Failed to resolve ERP department access for user_id=%s resource_type=%s",
            user_id,
            resource_type,
        )
        return set()
