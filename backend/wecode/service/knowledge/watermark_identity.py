# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Resolve trusted viewer identity for protected document watermarks."""

import json
import re
from dataclasses import dataclass
from typing import Any

from fastapi import HTTPException
from sqlalchemy.orm import Session

from wecode.models.erp_user import WecodeErpUser
from wecode.service.erp_entity_resolver import ErpEntityResolver

_CONTROL_CHARACTERS = re.compile(r"[\x00-\x1f\x7f]")
_MAX_IDENTITY_LENGTH = 80


@dataclass(frozen=True)
class WatermarkIdentity:
    display_name: str
    employee_id: str


def _load_preferences(raw_preferences: Any) -> dict[str, Any]:
    if isinstance(raw_preferences, dict):
        return dict(raw_preferences)
    if not raw_preferences:
        return {}
    try:
        parsed = json.loads(raw_preferences)
    except (TypeError, json.JSONDecodeError):
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _normalize(value: Any) -> str:
    normalized = str(value or "").strip()
    if _CONTROL_CHARACTERS.search(normalized):
        return ""
    return normalized[:_MAX_IDENTITY_LENGTH]


def resolve_watermark_identity(
    user: Any,
    db: Session | None = None,
) -> WatermarkIdentity:
    preferences = _load_preferences(getattr(user, "preferences", None))
    company_profile = preferences.get("company_profile")
    profile = company_profile if isinstance(company_profile, dict) else {}
    display_name = _normalize(profile.get("name"))
    employee_id = _normalize(profile.get("employee_id"))
    if db is not None and (not display_name or not employee_id):
        erp_user = (
            db.query(WecodeErpUser)
            .filter(WecodeErpUser.user_id == getattr(user, "id", None))
            .first()
        )
        if erp_user is not None:
            display_name = _normalize(erp_user.erp_name) or display_name
            employee_id = _normalize(erp_user.employee_id) or employee_id
    if db is not None and not employee_id:
        employee_id = _normalize(
            ErpEntityResolver().resolve_employee_id(
                db,
                getattr(user, "id", 0),
            )
        )
        if employee_id:
            db.expire_all()
            erp_user = (
                db.query(WecodeErpUser)
                .filter(WecodeErpUser.user_id == getattr(user, "id", None))
                .first()
            )
            if erp_user is not None:
                display_name = _normalize(erp_user.erp_name) or display_name
    display_name = display_name or _normalize(getattr(user, "user_name", ""))
    employee_id = employee_id or _normalize(getattr(user, "id", ""))
    if not display_name or not employee_id:
        raise HTTPException(
            status_code=409,
            detail={"error_code": "WATERMARK_IDENTITY_INCOMPLETE"},
        )
    return WatermarkIdentity(display_name=display_name, employee_id=employee_id)
