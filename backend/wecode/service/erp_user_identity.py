# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Resolve internal ERP employee identities to Wegent users."""

import logging
from typing import Optional

from app.models.user import User
from wecode.models.erp_user import WecodeErpUser
from wecode.service.erp_client import EmployeeInfo, erp_client

logger = logging.getLogger(__name__)


def normalize_employee_ids(employee_ids: list[str]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for employee_id in employee_ids:
        normalized = employee_id.strip()
        if not normalized or normalized in seen:
            continue
        seen.add(normalized)
        result.append(normalized)
    return result


def email_prefix(email: Optional[str]) -> Optional[str]:
    if not email or "@" not in email:
        return None
    prefix = email.split("@", 1)[0].strip()
    return prefix or None


def _search_employee_exact(employee_id: str) -> Optional[EmployeeInfo]:
    employee = erp_client.search_employee(employee_id)
    if not employee or not employee.ssn:
        return None
    if employee.ssn.strip().lower() != employee_id.strip().lower():
        return None
    return employee


def _query_existing_user_ids(db, user_ids: list[int], require_active: bool) -> set[int]:
    if not user_ids:
        return set()
    query = db.query(User.id).filter(User.id.in_(user_ids))
    if require_active:
        query = query.filter(User.is_active.is_(True))
    return {user_id for (user_id,) in query.all()}


def _find_user_by_email_prefix(db, prefix: str, require_active: bool) -> Optional[User]:
    query = db.query(User).filter(User.user_name == prefix)
    if require_active:
        query = query.filter(User.is_active.is_(True))
    return query.first()


def _resolve_user_ids_by_employee_ids(
    db,
    employee_ids: list[str],
    *,
    require_active: bool,
) -> list[int]:
    normalized_employee_ids = normalize_employee_ids(employee_ids)
    if not normalized_employee_ids:
        return []

    rows = (
        db.query(WecodeErpUser)
        .filter(WecodeErpUser.employee_id.in_(normalized_employee_ids))
        .all()
    )
    cached_user_ids = [
        row.user_id for row in rows if row.employee_id and row.user_id is not None
    ]
    existing_user_ids = _query_existing_user_ids(
        db,
        cached_user_ids,
        require_active=require_active,
    )
    user_ids_by_employee_id = {
        row.employee_id: row.user_id
        for row in rows
        if row.employee_id and row.user_id in existing_user_ids
    }
    missing_employee_ids = [
        employee_id
        for employee_id in normalized_employee_ids
        if employee_id not in user_ids_by_employee_id
    ]

    for employee_id in missing_employee_ids:
        try:
            employee = _search_employee_exact(employee_id)
        except Exception:
            logger.exception("ERP lookup failed for employee_id=%s", employee_id)
            continue
        prefix = email_prefix(employee.email if employee else None)
        if not prefix:
            continue
        user = _find_user_by_email_prefix(
            db,
            prefix,
            require_active=require_active,
        )
        if user:
            user_ids_by_employee_id[employee_id] = user.id

    ordered_user_ids: list[int] = []
    seen_user_ids: set[int] = set()
    for employee_id in normalized_employee_ids:
        user_id = user_ids_by_employee_id.get(employee_id)
        if user_id and user_id not in seen_user_ids:
            seen_user_ids.add(user_id)
            ordered_user_ids.append(user_id)
    return ordered_user_ids


def resolve_owner_user_ids_by_employee_ids(db, employee_ids: list[str]) -> list[int]:
    """Resolve owner filter employee identifiers to existing Wegent user IDs."""
    return _resolve_user_ids_by_employee_ids(
        db,
        employee_ids,
        require_active=False,
    )


def resolve_active_user_id_by_employee_id(db, employee_id: str) -> Optional[int]:
    """Resolve an authentication employee identifier to an active Wegent user ID."""
    user_ids = _resolve_user_ids_by_employee_ids(
        db,
        [employee_id],
        require_active=True,
    )
    if not user_ids:
        return None
    return user_ids[0]
