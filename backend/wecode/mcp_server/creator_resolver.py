# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Internal creator enrichment for external knowledge MCP responses."""

import logging

from app.schemas.knowledge_external import ExternalKnowledgeCreatorInfo
from app.services.knowledge.external_creator import (
    default_external_knowledge_creator_resolver,
)
from wecode.models.erp_user import WecodeErpUser
from wecode.service.erp_client import erp_client
from wecode.service.erp_user_identity import email_prefix

logger = logging.getLogger(__name__)

MAX_ERP_FALLBACK_LOOKUPS = 20


def _cached_creator_attributes(row: WecodeErpUser, fallback_user_name: str) -> dict:
    prefix = email_prefix(row.email) or fallback_user_name
    return {
        "employee_id": row.employee_id,
        "email_prefix": prefix,
        "name": row.erp_name,
    }


def _erp_creator_attributes(user_name: str) -> dict:
    try:
        employee = erp_client.search_employee(user_name)
    except Exception:
        logger.exception(
            "ERP creator attribute lookup failed for user_name=%s",
            user_name,
        )
        return {}
    if not employee:
        return {}
    if (email_prefix(employee.email) or "").lower() != user_name.lower():
        return {}
    return {
        "employee_id": employee.ssn or "",
        "email_prefix": email_prefix(employee.email) or user_name,
        "name": employee.name or "",
    }


def wecode_creator_resolver(
    db,
    user_ids: list[int],
) -> dict[int, ExternalKnowledgeCreatorInfo]:
    base_creator_map = default_external_knowledge_creator_resolver(db, user_ids)
    if not base_creator_map:
        return {}

    rows = db.query(WecodeErpUser).filter(WecodeErpUser.user_id.in_(user_ids)).all()
    attributes_by_user_id = {
        row.user_id: _cached_creator_attributes(
            row,
            base_creator_map[row.user_id].user_name,
        )
        for row in rows
        if row.user_id in base_creator_map
    }

    missing_user_ids = [
        user_id for user_id in user_ids if user_id not in attributes_by_user_id
    ]
    for user_id in missing_user_ids[:MAX_ERP_FALLBACK_LOOKUPS]:
        creator = base_creator_map.get(user_id)
        if not creator:
            continue
        attributes = _erp_creator_attributes(creator.user_name)
        if attributes:
            attributes_by_user_id[user_id] = attributes

    return {
        user_id: creator.model_copy(
            update={"attributes": attributes_by_user_id.get(user_id, {})}
        )
        for user_id, creator in base_creator_map.items()
    }
