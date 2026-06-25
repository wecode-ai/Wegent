# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Monkey-patch app.api.endpoints.oidc OIDC callback to implement wecode-specific git_info handling
without modifying open-source files.

Requirement:
- In oidc_callback, when creating a new user, DO NOT set git_info to [].
- Instead, call paas API to fetch git tokens and compose complete git_info (validated),
  then update the user with this git_info.
- Logic references wecode/api/auth.py "get and validate git token information logic".

Approach:
- Replace the GET /callback endpoint handler at runtime.
- Re-implement the original endpoint behavior, with modification for new-user creation git_info handling.
"""

import json
import logging
import time
import uuid
from typing import Any, Dict
from urllib.parse import quote

import jwt
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query
from fastapi.responses import RedirectResponse
from sqlalchemy.orm import Session

try:
    # Import target module to access router and services
    from app.api.dependencies import get_db
    from app.api.endpoints import oidc as oidc_module
    from app.core import security
    from app.core.config import settings
    from app.core.security import create_access_token
    from app.models.user import User
    from app.services.oidc import oidc_service
except Exception:
    oidc_module = None  # type: ignore
    get_db = None  # type: ignore
    create_access_token = None  # type: ignore
    settings = None  # type: ignore
    User = None  # type: ignore
    security = None  # type: ignore
    oidc_service = None  # type: ignore

from app.schemas.user import UserUpdate
from app.services.k_batch import apply_default_resources_async
from app.services.user import user_service

# wecode services
from wecode.service.get_user_gitinfo import get_user_gitinfo

logger = logging.getLogger(__name__)
router = APIRouter()
COMPANY_PROFILE_PREFERENCE_KEY = "company_profile"


def _normalize_frontend_base_path(value: str | None) -> str:
    if not value or value == "/":
        return ""

    trimmed = value.strip()
    if not trimmed.startswith("/") or trimmed.startswith("//"):
        return ""
    if "\\" in trimmed or "?" in trimmed or "#" in trimmed:
        return ""

    parts: list[str] = []
    for part in trimmed.split("/"):
        if not part or part == ".":
            continue
        if part == "..":
            parts.pop() if parts else None
            continue
        parts.append(part)

    return f"/{'/'.join(parts)}" if parts else ""


def _build_frontend_url(path: str, frontend_base_path: str | None = None) -> str:
    base_url = settings.FRONTEND_URL.rstrip("/")
    app_base_path = _normalize_frontend_base_path(frontend_base_path)
    normalized_path = path if path.startswith("/") else f"/{path}"
    return f"{base_url}{app_base_path}{normalized_path}"


def _clean_profile_value(value: Any) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str):
        value = str(value)
    value = value.strip()
    return value or None


def _store_company_profile_preference(
    user: User,
    *,
    employee_id: str | None = None,
    name: str | None = None,
) -> bool:
    clean_employee_id = _clean_profile_value(employee_id)
    clean_name = _clean_profile_value(name)
    if not clean_employee_id and not clean_name:
        return False

    preferences = oidc_module._load_preferences(user.preferences)
    company_profile = preferences.get(COMPANY_PROFILE_PREFERENCE_KEY)
    if not isinstance(company_profile, dict):
        company_profile = {}

    changed = False
    if clean_employee_id and company_profile.get("employee_id") != clean_employee_id:
        company_profile["employee_id"] = clean_employee_id
        changed = True
    if clean_name and company_profile.get("name") != clean_name:
        company_profile["name"] = clean_name
        changed = True

    if not changed:
        return False

    preferences[COMPANY_PROFILE_PREFERENCE_KEY] = company_profile
    user.preferences = json.dumps(preferences, ensure_ascii=False)
    return True


async def _patched_oidc_callback(
    background_tasks: BackgroundTasks,
    code: str = Query(..., description="Authorization code"),
    state: str = Query(..., description="State parameter"),
    error: str = Query(None, description="Error information"),
    db: Session = Depends(get_db),
):
    """
    Patched OIDC callback handler:
    - If new user is created, do NOT set git_info=[].
    - After creation, fetch git tokens from paas, validate and compose git_info, then update user.
    - Other behavior remains consistent with app/api/endpoints/oidc.py.
    """
    if error:
        logger.error(f"OIDC callback error: {error}")
        error_url = _build_frontend_url(
            f"/login?error=oidc_error&message={error}",
        )
        return RedirectResponse(url=error_url, status_code=302)

    # Verify state parameter (JWT)
    redirect_after_login = None
    frontend_base_path = None
    try:
        payload = jwt.decode(
            state, settings.OIDC_STATE_SECRET_KEY, algorithms=["HS256"]
        )
        nonce = payload["nonce"]
        redirect_after_login = payload.get("redirect")
        frontend_base_path = payload.get("frontend_base_path")
        now = int(time.time())
        if now > payload["exp"]:
            logger.error(f"State parameter expired: {state}")
            error_url = _build_frontend_url(
                "/login?error=expired_state&message=State parameter expired",
                frontend_base_path,
            )
            return RedirectResponse(url=error_url, status_code=302)
    except Exception as e:
        logger.error(f"Invalid state parameter: {state}, error: {e}")
        error_url = _build_frontend_url(
            "/login?error=invalid_state&message=Invalid state parameter",
        )
        return RedirectResponse(url=error_url, status_code=302)

    try:
        tokens = await oidc_service.exchange_code_for_tokens(code, state)

        id_token = tokens.get("id_token")
        if not id_token:
            raise Exception("Missing ID Token in response")

        claims = await oidc_service.verify_id_token(id_token, nonce)

        # Get user information (optional)
        access_token = tokens.get("access_token")
        user_info: Dict[str, Any] = {}
        if access_token:
            user_info = await oidc_service.get_user_info(access_token)

        user_data = {**claims, **user_info}

        user_id = user_data.get("sub")
        email = (
            user_data.get("email")
            or user_data.get("preferred_username")
            or f"{user_id}@unknown.email"
        )
        name = user_data.get("name") or user_data.get("preferred_username") or user_id

        if not user_id:
            raise Exception("Missing user identifier in ID Token")

        logger.info(f"OIDC user info: user_id={user_id}, email={email}, name={name}")

        # Find or create user
        user_name = email.split("@")[0] if "@" in email else user_id
        employee_id = oidc_module._extract_cas_employee_id(user_data)

        user = db.query(User).filter(User.user_name == user_name).first()

        created_new_user = False
        if not user:
            preferences = {}
            company_profile = {
                key: value
                for key, value in {
                    "employee_id": _clean_profile_value(employee_id),
                    "name": _clean_profile_value(name),
                }.items()
                if value
            }
            if company_profile:
                preferences[COMPANY_PROFILE_PREFERENCE_KEY] = company_profile
            # Create new user WITHOUT forcing git_info = []
            user = User(
                user_name=user_name,
                email=email,
                is_active=True,
                password_hash=security.get_password_hash(str(uuid.uuid4())),
                preferences=json.dumps(preferences, ensure_ascii=False),
            )
            db.add(user)
            db.commit()
            db.refresh(user)
            created_new_user = True
            logger.info(
                f"Created new OIDC user: user_id={user.id}, user_name={user.user_name}"
            )

            # Apply default resources for new user
            background_tasks.add_task(apply_default_resources_async, user.id)
        else:
            # Update user email if changed
            changed = False
            if user.email != email:
                user.email = email
                changed = True
            changed = (
                _store_company_profile_preference(
                    user, employee_id=employee_id, name=name
                )
                or changed
            )
            if changed:
                db.commit()
            db.refresh(user)
            logger.info(
                f"Found existing OIDC user: user_id={user.id}, user_name={user.user_name}"
            )

        if not user.is_active:
            logger.warning(
                f"User not active: user_id={user.id}, user_name={user.user_name}"
            )
            raise Exception("User not active")

        # Wecode-specific: for newly created user, fetch and validate git token info from paas,
        # then compose and update user.git_info (similar to wecode/api/auth.py CAS login logic).
        if created_new_user:
            try:
                # Fetch and validate git token info
                new_gitlab_info = get_user_gitinfo.get_and_validate_git_info(user_name)

                # Merge existing git_info (keep non-gitlab info)
                merged_git_info = []
                if user.git_info:
                    for existing_item in user.git_info:
                        if existing_item.get("type") != "gitlab":
                            merged_git_info.append(existing_item)

                if new_gitlab_info:
                    merged_git_info.extend(new_gitlab_info)

                if merged_git_info:
                    user_update = UserUpdate(git_info=merged_git_info)
                    # Validation already done in wecode/service/get_user_gitinfo, skip here
                    user_service.update_current_user(
                        db=db, user=user, obj_in=user_update, validate_git_info=False
                    )
                    logger.info(
                        f"OIDC new user git_info initialized: user_id={user.id}, count={len(merged_git_info)}"
                    )
            except Exception as e:
                # Do not interrupt login flow, log error
                logger.error(f"OIDC git_info initialization failed: {str(e)}")

        # Sync ERP profile from OpenSearch API using email for unique match
        try:
            from wecode.service.erp_client import erp_client
            from wecode.service.erp_entity_resolver import ErpEntityResolver
            from wecode.service.erp_user_service import ErpUserService

            erp_employee = erp_client.search_employee(email)
            if erp_employee and erp_employee.ssn:
                preference_changed = _store_company_profile_preference(
                    user,
                    employee_id=erp_employee.ssn,
                    name=erp_employee.name,
                )
                ErpUserService.upsert_profile(
                    db=db,
                    user_id=user.id,
                    employee_id=erp_employee.ssn,
                    department_name=erp_employee.department,
                    erp_name=erp_employee.name,
                    email=erp_employee.email,
                )
                if preference_changed:
                    db.commit()
                logger.info(
                    f"Synced ERP profile for OIDC user {user.id}: "
                    f"emp={ErpEntityResolver._mask_ssn(erp_employee.ssn or '')}, "
                    f"dept={erp_employee.department}"
                )
            else:
                logger.info(
                    f"No ERP employee found for OIDC user {user.id} with email={email}"
                )
        except Exception as e:
            logger.warning(f"Failed to sync ERP profile for OIDC user {user.id}: {e}")

        jwt_token = create_access_token(
            data={"sub": user.user_name, "user_id": user.id}
        )

        logger.info(
            f"OIDC login success: user_id={user.id}, user_name={user.user_name}"
        )

        redirect_url = _build_frontend_url(
            f"/login/oidc?access_token={jwt_token}&token_type=bearer&login_success=true",
            frontend_base_path,
        )
        if redirect_after_login:
            redirect_url += f"&redirect={quote(redirect_after_login)}"

        return RedirectResponse(url=redirect_url, status_code=302)

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"OIDC callback processing failed: {e}")
        error_url = _build_frontend_url(
            f"/login?error=authentication_failed&message={str(e)}",
            frontend_base_path,
        )
        return RedirectResponse(url=error_url, status_code=302)


def apply_patch() -> None:
    """
    Patch the OIDC router: replace GET /callback endpoint implementation.
    """
    if oidc_module is None:
        logger.error("OIDC patch FAILED: oidc_module import failed")
        return

    target_router = getattr(oidc_module, "router", None)
    if target_router is None or not hasattr(target_router, "routes"):
        logger.error("OIDC patch FAILED: target router not found")
        return

    patched = False
    for route in target_router.routes:
        path = getattr(route, "path", None)
        methods = getattr(route, "methods", set())
        endpoint = getattr(route, "endpoint", None)
        if (
            path == "/callback"
            and ("GET" in methods)
            and callable(endpoint)
            and not getattr(endpoint, "_wecode_patched", False)
        ):
            # Replace route endpoint
            setattr(_patched_oidc_callback, "_wecode_patched", True)
            route.endpoint = _patched_oidc_callback
            patched = True

    if not patched:
        logger.error(
            "OIDC patch FAILED: /callback GET route not found or already patched"
        )
    else:
        logger.info("OIDC patch applied successfully")


# Auto-apply on import
apply_patch()
