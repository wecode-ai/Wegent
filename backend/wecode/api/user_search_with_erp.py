# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
User search endpoint with ERP user info.

Returns user search results enriched with ERP profile data
(erp_name, employee_id, department_name) from wecode_erp_user table.

This endpoint is used by the KB collaborator search UI.
"""

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core.security import get_current_user
from app.models.user import User
from wecode.models.erp_user import WecodeErpUser

router = APIRouter()

_MAX_QUERY_LEN = 100


@router.get("/search")
def search_users_with_erp(
    q: str = Query(..., min_length=1, max_length=_MAX_QUERY_LEN),
    limit: int = Query(default=20, ge=1, le=100),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Search users with ERP profile info."""
    from sqlalchemy import or_

    search_pattern = f"%{q}%"
    users = (
        db.query(User)
        .outerjoin(WecodeErpUser, User.id == WecodeErpUser.user_id)
        .filter(
            User.is_active == True,
            User.id != current_user.id,
            or_(
                User.user_name.ilike(search_pattern),
                User.email.ilike(search_pattern),
                WecodeErpUser.erp_name.ilike(search_pattern),
                WecodeErpUser.employee_id.ilike(search_pattern),
            ),
        )
        .limit(limit)
        .all()
    )

    if not users:
        return {"users": [], "total": 0}

    # Batch lookup ERP info
    user_ids = [u.id for u in users]
    erp_map: dict[int, WecodeErpUser] = {}
    for erp in (
        db.query(WecodeErpUser).filter(WecodeErpUser.user_id.in_(user_ids)).all()
    ):
        erp_map[erp.user_id] = erp

    result_users = []
    for user in users:
        erp = erp_map.get(user.id)
        result_users.append(
            {
                "id": user.id,
                "user_name": user.user_name,
                "email": user.email,
                "erp_name": erp.erp_name if erp else None,
                "employee_id": erp.employee_id if erp else None,
                "department_name": erp.department_name if erp else None,
            }
        )

    return {"users": result_users, "total": len(result_users)}
