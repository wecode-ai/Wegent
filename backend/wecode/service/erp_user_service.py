# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Shared service for upserting WecodeErpUser profile records.

Used by CAS login, OIDC callback, and lazy-sync to avoid repeating the
"find-or-create → update fields → commit" logic in three places.
"""

from datetime import datetime
from typing import Optional

from sqlalchemy.orm import Session

from wecode.models.erp_user import WecodeErpUser


class ErpUserService:
    @staticmethod
    def upsert_profile(
        db: Session,
        user_id: int,
        employee_id: Optional[str] = None,
        department_name: Optional[str] = None,
        erp_name: Optional[str] = None,
        email: Optional[str] = None,
    ) -> Optional[WecodeErpUser]:
        """Find or create a WecodeErpUser and update the provided fields."""
        if not any([employee_id, department_name, erp_name, email]):
            return None

        profile = (
            db.query(WecodeErpUser).filter(WecodeErpUser.user_id == user_id).first()
        )

        if profile:
            if employee_id:
                profile.employee_id = employee_id
            if department_name:
                profile.department_name = department_name
            if erp_name:
                profile.erp_name = erp_name
            if email:
                profile.email = email
            profile.last_synced_at = datetime.utcnow()
        else:
            profile = WecodeErpUser(
                user_id=user_id,
                employee_id=employee_id or "",
                department_name=department_name or "",
                erp_name=erp_name or "",
                email=email or "",
                last_synced_at=datetime.utcnow(),
            )
            db.add(profile)

        db.commit()
        return profile
