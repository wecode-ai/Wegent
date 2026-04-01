# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import json
import logging
import uuid
import xml.etree.ElementTree as ET
from urllib.parse import quote

import httpx
from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core import security
from app.core.security import create_access_token, get_admin_user, get_password_hash
from app.models.user import User
from app.schemas.user import LoginResponse, Token, UserUpdate
from app.services.k_batch import apply_default_resources_sync
from app.services.user import user_service
from wecode.config.aidesk_config import aidesk_config
from wecode.service.aidesk_auth_service import aidesk_auth_service
from wecode.service.get_user_gitinfo import get_user_gitinfo

router = APIRouter()


@router.post("/login")
async def cas_login(
    ticket: str = Query(..., description="CAS ticket"),
    service: str = Query(..., description="CAS service identifier"),
    db: Session = Depends(get_db),
) -> LoginResponse:
    """
    CAS Single Sign-On (SSO) Login Endpoint

    This endpoint receives CAS ticket and service identifier, validates the ticket,
    finds or creates user based on validation result, and returns access token

    Args:
        ticket: Ticket issued by CAS server
        service: Service identifier

    Returns:
        dict: Response containing access token and token type
    """
    logger = logging.getLogger("cas_login")

    # CAS validation URL template
    CAS_VALIDATE_URL = "https://cas.erp.sina.com.cn/cas/validate?ticket={ticket}&service={service}&codetype=utf8"

    # Parameter validation
    if not ticket or not service:
        logger.error(f"Missing parameters: ticket={ticket}, service={service}")
        raise HTTPException(status_code=400, detail="ticket or service is empty")

    # Build validation URL
    url = CAS_VALIDATE_URL.format(ticket=ticket, service=quote(service))
    logger.info(f"Requesting CAS validation interface: {url}")

    try:
        # Send validation request to CAS server
        async with httpx.AsyncClient() as client:
            response = await client.get(url, timeout=10)
            response.raise_for_status()

        logger.info(f"CAS response content: {response.text}")

    except httpx.RequestError as e:
        logger.error(f"CAS validation request failed: {str(e)}")
        raise HTTPException(
            status_code=502, detail=f"CAS validation request failed: {str(e)}"
        )

    try:
        # Parse CAS response XML
        root = ET.fromstring(response.text)

        # Compatible with Sina CAS return structure <user><info><username>xxx</username><email>xxx</email>...</info></user>
        info_node = root.find("info")

        if info_node is None:
            logger.error("CAS response format error: info node not found")
            raise HTTPException(status_code=502, detail="CAS response format error")

        # Extract user information
        user_name = info_node.findtext("email") or info_node.findtext("username")
        email = (
            info_node.findtext("fullemail")
            or info_node.findtext("email")
            or f"{user_name}@unknown.email"
        )

        if not user_name:
            logger.error("Missing user identifier in CAS response")
            raise HTTPException(
                status_code=502, detail="Missing user identifier in CAS response"
            )

        logger.info(
            f"Parsed CAS user information: user_name={user_name}, email={email}"
        )

    except ET.ParseError as e:
        logger.error(f"CAS response parsing failed: {str(e)}")
        raise HTTPException(
            status_code=502, detail=f"CAS response parsing failed: {str(e)}"
        )

    try:
        # Find or create user
        user = db.scalar(select(User).where(User.user_name == user_name))

        if not user:
            # Create new user
            user = User(
                user_name=user_name,
                email=email,
                is_active=True,
                password_hash=security.get_password_hash(
                    "123456"
                ),  # CAS authentication doesn't require password
                git_info=[],
            )
            db.add(user)
            db.commit()
            db.refresh(user)
            logger.info(
                f"Created new CAS user: user_id={user.id}, user_name={user.user_name}"
            )
        else:
            # Update user information (if needed)
            if user.email != email:
                user.email = email
                db.commit()
                db.refresh(user)
            logger.info(
                f"Found existing CAS user: user_id={user.id}, user_name={user.user_name}"
            )

        # Check user status
        if not user.is_active:
            logger.warning(
                f"User not activated: user_id={user.id}, user_name={user.user_name}"
            )
            raise HTTPException(status_code=400, detail="User not active")

        # Get and validate git token information
        try:
            # Get new gitlab information
            new_gitlab_info = get_user_gitinfo.get_and_validate_git_info(user_name)

            # Merge existing git_info (keep non-gitlab information like github)
            merged_git_info = []

            # First add existing non-gitlab information
            if user.git_info:
                for existing_item in user.git_info:
                    if existing_item.get("type") != "gitlab":
                        merged_git_info.append(existing_item)

            # Then add new gitlab information
            if new_gitlab_info:
                merged_git_info.extend(new_gitlab_info)

            # Update user information (don't validate token since we already validated it)
            if merged_git_info:
                user_update = UserUpdate(git_info=merged_git_info)
                user_service.update_current_user(
                    db=db, user=user, obj_in=user_update, validate_git_info=False
                )
                logger.info(
                    f"Updated user git_info: user_id={user.id}, git_info_count={len(merged_git_info)}"
                )

        except Exception as e:
            logger.error(f"Failed to get git token: {str(e)}")
            # Continue login flow, don't interrupt

        # Create access token
        access_token = create_access_token(data={"sub": user.user_name})

        logger.info(f"CAS login success: user_id={user.id}, user_name={user.user_name}")

        return LoginResponse(access_token=access_token, token_type="bearer")

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"CAS login processing failed: {str(e)}")
        raise HTTPException(
            status_code=500, detail=f"CAS login processing failed: {str(e)}"
        )


@router.post("/generate-user-token", response_model=Token)
async def generate_user_token(
    user_name: str = Query(..., description="Username to generate token for"),
    expires_minutes: int = Query(60, description="Token expiration time in minutes"),
    current_admin: User = Depends(get_admin_user),
    db: Session = Depends(get_db),
) -> Token:
    """
    Generate user token with specified expiration time (Admin only)

    This endpoint generates an access token for a specified user with custom expiration.
    Requires admin authentication via Bearer token.

    Args:
        user_name: Username to generate token for
        expires_minutes: Token expiration time in minutes (default: 60)
        current_admin: Current admin user (from Bearer token)

    Returns:
        Token: Access token and token type

    Raises:
        HTTPException: If not admin or user not found
    """
    logger = logging.getLogger("generate_user_token")

    # Find user by username
    user = db.scalar(select(User).where(User.user_name == user_name))
    if not user:
        logger.error(f"User not found: {user_name}")
        raise HTTPException(status_code=404, detail=f"User '{user_name}' not found")

    # Check if user is active
    if not user.is_active:
        logger.error(f"User not active: {user_name}")
        raise HTTPException(status_code=400, detail=f"User '{user_name}' is not active")

    # Create access token with specified expiration
    access_token = create_access_token(
        data={"sub": user.user_name}, expires_delta=expires_minutes
    )

    logger.info(
        f"Admin '{current_admin.user_name}' generated token for user '{user_name}', "
        f"expires in {expires_minutes} minutes"
    )

    return Token(access_token=access_token, token_type="bearer")


# Aidesk authentication models
class AideskLoginRequest(BaseModel):
    """Aidesk login request body."""

    source: str
    username: str
    timestamp: str
    sign: str


class AideskLoginResponse(BaseModel):
    """Aidesk login response."""

    access_token: str
    token_type: str = "bearer"
    user: dict


@router.post("/aidesk/login")
async def aidesk_login(
    request: Request,
    body: AideskLoginRequest,
    db: Session = Depends(get_db),
) -> AideskLoginResponse:
    """
    Aidesk SSO login endpoint.

    Validates signature from 口袋 App WebView and returns JWT token.

    Args:
        request: FastAPI request object
        body: Aidesk login request containing source, username, timestamp, and sign

    Returns:
        AideskLoginResponse: Access token and user info

    Raises:
        HTTPException: If authentication fails
    """
    logger = logging.getLogger("aidesk_login")

    # Check if aidesk auth is enabled
    if not aidesk_config.auth_enabled:
        logger.warning("[Aidesk] Auth is disabled")
        raise HTTPException(status_code=403, detail="Aidesk authentication is disabled")

    # Verify source
    if body.source != "aidesk":
        logger.warning(f"[Aidesk] Invalid source: {body.source}")
        raise HTTPException(status_code=400, detail="Invalid source")

    # Verify signature
    is_valid, error_msg = aidesk_auth_service.verify_signature(
        source=body.source,
        username=body.username,
        timestamp=body.timestamp,
        sign=body.sign,
    )

    if not is_valid:
        logger.warning(f"[Aidesk] Auth failed for user={body.username}: {error_msg}")
        raise HTTPException(status_code=401, detail=error_msg)

    # Find or create user
    user_name = body.username.strip()
    user = db.scalar(select(User).where(User.user_name == user_name))

    if not user:
        # Create new user with auth_source="oidc" to allow OIDC login
        logger.info(f"[Aidesk] Creating new user: {user_name}")
        new_user = User(
            user_name=user_name,
            email=f"{user_name}@aidesk.user",  # Placeholder email
            password_hash=get_password_hash(str(uuid.uuid4())),
            git_info=[],
            is_active=True,
            preferences=json.dumps({}),
            auth_source="oidc",  # Use oidc to allow OIDC login
        )
        db.add(new_user)
        db.commit()
        db.refresh(new_user)
        user = new_user

        # Apply default resources for new users
        try:
            apply_default_resources_sync(new_user.id)
        except Exception as e:
            logger.warning(
                f"[Aidesk] Failed to apply default resources for user {new_user.id}: {e}"
            )
    else:
        # Update auth_source if needed (set to oidc to allow OIDC login)
        if user.auth_source == "unknown":
            logger.info(f"[Aidesk] Updating auth_source for user: {user_name}")
            user.auth_source = "oidc"
            db.commit()

    # Check if user is active
    if not user.is_active:
        logger.warning(f"[Aidesk] User not active: {user_name}")
        raise HTTPException(status_code=400, detail="User is not active")

    # Generate JWT token
    access_token = security.create_access_token(data={"sub": user.user_name})

    logger.info(f"[Aidesk] User logged in successfully: {user.user_name}")

    return AideskLoginResponse(
        access_token=access_token,
        user={
            "id": user.id,
            "user_name": user.user_name,
            "email": user.email,
            "role": user.role,
            "auth_source": user.auth_source,
        },
    )
    return Token(access_token=access_token, token_type="bearer")
