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

import logging
import time
import jwt
from typing import Any, Dict

from fastapi import APIRouter, Depends, Query, HTTPException
from fastapi.responses import RedirectResponse
from sqlalchemy.orm import Session
from sqlalchemy import select

try:
    # Import target module to access router and services
    from app.api.endpoints import oidc as oidc_module
    from app.api.dependencies import get_db
    from app.core.security import create_access_token
    from app.core.config import settings
    from app.models.user import User
    from app.core import security
    from app.services.oidc import oidc_service
except Exception:
    oidc_module = None  # type: ignore
    get_db = None  # type: ignore
    create_access_token = None  # type: ignore
    settings = None  # type: ignore
    User = None  # type: ignore
    security = None  # type: ignore
    oidc_service = None  # type: ignore

# wecode services
from wecode.service.get_user_gitinfo import get_user_gitinfo
from app.services.user import user_service
from app.schemas.user import UserUpdate


logger = logging.getLogger(__name__)
router = APIRouter()


async def _patched_oidc_callback(
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
        error_url = f"{settings.FRONTEND_URL}/login?error=oidc_error&message={error}"
        return RedirectResponse(url=error_url, status_code=302)

    # Verify state parameter (JWT)
    try:
        payload = jwt.decode(state, settings.OIDC_STATE_SECRET_KEY, algorithms=["HS256"])
        nonce = payload["nonce"]
        now = int(time.time())
        if now > payload["exp"]:
            logger.error(f"State parameter expired: {state}")
            error_url = f"{settings.FRONTEND_URL}/login?error=expired_state&message=State parameter expired"
            return RedirectResponse(url=error_url, status_code=302)
    except Exception as e:
        logger.error(f"Invalid state parameter: {state}, error: {e}")
        error_url = f"{settings.FRONTEND_URL}/login?error=invalid_state&message=Invalid state parameter"
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
        email = user_data.get("email") or user_data.get("preferred_username") or f"{user_id}@unknown.email"
        name = user_data.get("name") or user_data.get("preferred_username") or user_id

        if not user_id:
            raise Exception("Missing user identifier in ID Token")

        logger.info(f"OIDC user info: user_id={user_id}, email={email}, name={name}")

        # Find or create user
        user_name = email.split("@")[0] if "@" in email else user_id

        user = db.scalar(select(User).where(User.user_name == user_name))

        created_new_user = False
        if not user:
            # Create new user WITHOUT forcing git_info = []
            user = User(
                user_name=user_name,
                email=email,
                is_active=True,
                password_hash=security.get_password_hash("oidc_user"),
            )
            db.add(user)
            db.commit()
            db.refresh(user)
            created_new_user = True
            logger.info(f"Created new OIDC user: user_id={user.id}, user_name={user.user_name}")
        else:
            # Update user email if changed
            if user.email != email:
                user.email = email
                db.commit()
                db.refresh(user)
            logger.info(f"Found existing OIDC user: user_id={user.id}, user_name={user.user_name}")

        if not user.is_active:
            logger.warning(f"User not active: user_id={user.id}, user_name={user.user_name}")
            raise Exception("User not active")

        # Wecode-specific: for newly created user, fetch and validate git token info from paas,
        # then compose and update user.git_info (similar to wecode/api/auth.py CAS login logic).
        if created_new_user:
            try:
                # Fetch and validate git token info
                new_gitlab_info = await get_user_gitinfo.get_and_validate_git_info(user_name)
 
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
                    user_service.update_current_user(db=db, user=user, obj_in=user_update, validate_git_info=False)
                    logger.info(f"OIDC new user git_info initialized: user_id={user.id}, count={len(merged_git_info)}")
            except Exception as e:
                # Do not interrupt login flow, log error
                logger.error(f"OIDC git_info initialization failed: {str(e)}")

        jwt_token = create_access_token(data={"sub": user.user_name})

        logger.info(f"OIDC login success: user_id={user.id}, user_name={user.user_name}")

        redirect_url = f"{settings.FRONTEND_URL}/login/oidc?access_token={jwt_token}&token_type=bearer&login_success=true"

        return RedirectResponse(url=redirect_url, status_code=302)

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"OIDC callback processing failed: {e}")
        error_url = f"{settings.FRONTEND_URL}/login?error=authentication_failed&message={str(e)}"
        return RedirectResponse(url=error_url, status_code=302)


def apply_patch() -> None:
    """
    Patch the OIDC router: replace GET /callback endpoint implementation.
    """
    if oidc_module is None:
        return

    target_router = getattr(oidc_module, "router", None)
    if target_router is None or not hasattr(target_router, "routes"):
        return

    for route in target_router.routes:
        path = getattr(route, "path", None)
        methods = getattr(route, "methods", set())
        endpoint = getattr(route, "endpoint", None)
        if path == "/callback" and ("GET" in methods) and callable(endpoint) and not getattr(endpoint, "_wecode_patched", False):
            # Replace route endpoint
            setattr(_patched_oidc_callback, "_wecode_patched", True)
            route.endpoint = _patched_oidc_callback


# Auto-apply on import
apply_patch()