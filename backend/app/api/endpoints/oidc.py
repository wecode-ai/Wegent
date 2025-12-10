# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import json
import logging
import secrets
import time
import uuid

import jwt  # pip install pyjwt
from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import HTMLResponse, RedirectResponse
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core.cache import cache_manager
from app.core.config import settings
from app.core.security import create_access_token
from app.models.user import User
from app.schemas.user import (
    CLILoginInitRequest,
    CLILoginInitResponse,
    CLIPollResponse,
    LoginResponse,
    UserAuthTypeResponse,
)
from app.services.k_batch import (
    apply_default_resources_async,
    apply_default_resources_sync,
)
from app.services.oidc import oidc_service

logger = logging.getLogger(__name__)

router = APIRouter()

STATE_JWT_SECRET = settings.OIDC_STATE_SECRET_KEY
STATE_EXPIRE_TIME = settings.OIDC_STATE_EXPIRE_SECONDS

# CLI login session TTL (5 minutes)
CLI_SESSION_EXPIRE_SECONDS = 300
CLI_SESSION_KEY_PREFIX = "cli_login_session:"


@router.get("/login")
async def oidc_login():
    """
    OpenID Connect login endpoint

    Generate authorization URL and redirect to OIDC provider
    """
    try:
        nonce = secrets.token_urlsafe(32)
        now = int(time.time())
        payload = {"nonce": nonce, "iat": now, "exp": now + STATE_EXPIRE_TIME}
        state = jwt.encode(payload, STATE_JWT_SECRET, algorithm="HS256")
        auth_url = await oidc_service.get_authorization_url(state, nonce)

        logger.info(f"OIDC login redirect: {auth_url}")
        return RedirectResponse(url=auth_url)

    except Exception as e:
        logger.error(f"OIDC login failed: {e}")
        raise HTTPException(status_code=500, detail=f"OIDC login failed: {e}")


@router.get("/callback")
async def oidc_callback(
    code: str = Query(..., description="Authorization code"),
    state: str = Query(..., description="State parameter"),
    error: str = Query(None, description="Error information"),
    db: Session = Depends(get_db),
):
    """
    OpenID Connect callback handler

    Handle OIDC provider callback, verify authorization code and create user session, then redirect to frontend
    """
    if error:
        logger.error(f"OIDC callback error: {error}")
        error_url = f"{settings.FRONTEND_URL}/login?error=oidc_error&message={error}"
        return RedirectResponse(url=error_url, status_code=302)

    # Verify state parameter (JWT)
    try:
        payload = jwt.decode(state, STATE_JWT_SECRET, algorithms=["HS256"])
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
        user_info = {}
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

        user = db.scalar(select(User).where(User.user_name == user_name))

        if not user:
            from app.core import security

            user = User(
                user_name=user_name,
                email=email,
                is_active=True,
                password_hash=security.get_password_hash(str(uuid.uuid4())),
                git_info=[],
                auth_source="oidc",
            )
            db.add(user)
            db.commit()
            db.refresh(user)
            logger.info(
                f"Created new OIDC user: user_id={user.id}, user_name={user.user_name}"
            )

            # Apply default resources synchronously for new OIDC users
            apply_default_resources_sync(user.id)
        else:
            if user.email != email:
                user.email = email
            # Update auth_source if it was unknown
            if user.auth_source == "unknown":
                user.auth_source = "oidc"
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

        jwt_token = create_access_token(data={"sub": user.user_name})

        logger.info(
            f"OIDC login success: user_id={user.id}, user_name={user.user_name}"
        )

        redirect_url = f"{settings.FRONTEND_URL}/login/oidc?access_token={jwt_token}&token_type=bearer&login_success=true"

        return RedirectResponse(url=redirect_url, status_code=302)

    except Exception as e:
        logger.error(f"OIDC callback processing failed: {e}")
        error_url = f"{settings.FRONTEND_URL}/login?error=authentication_failed&message={str(e)}"
        return RedirectResponse(url=error_url, status_code=302)


@router.get("/metadata")
async def get_oidc_metadata():
    """
    Get OIDC provider metadata

    Used for debugging and configuration validation
    """
    try:
        metadata = await oidc_service.get_metadata()
        return metadata
    except Exception as e:
        logger.error(f"Failed to get OIDC metadata: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to get OIDC metadata: {e}")


# CLI OIDC Login Endpoints


@router.get("/user-auth-type", response_model=UserAuthTypeResponse)
async def get_user_auth_type(
    username: str = Query(..., description="Username to query"),
    db: Session = Depends(get_db),
):
    """
    Query user's authentication type by username.

    Returns the auth_source for the user if found, otherwise returns exists=False.
    """
    user = db.scalar(select(User).where(User.user_name == username))

    if not user:
        return UserAuthTypeResponse(exists=False, auth_source=None)

    return UserAuthTypeResponse(exists=True, auth_source=user.auth_source)


@router.post("/cli-login", response_model=CLILoginInitResponse)
async def cli_oidc_login_init(request: CLILoginInitRequest):
    """
    Initialize CLI OIDC login flow.

    Receives a session_id from CLI, stores it in Redis, and returns the browser auth URL.
    """
    session_id = request.session_id

    # Validate session_id format (UUID v4)
    try:
        uuid.UUID(session_id, version=4)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid session_id format")

    # Create session in Redis with pending status
    session_key = f"{CLI_SESSION_KEY_PREFIX}{session_id}"
    session_data = {"status": "pending"}

    success = await cache_manager.set(
        session_key, session_data, expire=CLI_SESSION_EXPIRE_SECONDS
    )
    if not success:
        raise HTTPException(status_code=500, detail="Failed to create login session")

    # Generate OIDC auth URL with session_id in state
    try:
        nonce = secrets.token_urlsafe(32)
        now = int(time.time())
        payload = {
            "nonce": nonce,
            "iat": now,
            "exp": now + STATE_EXPIRE_TIME,
            "cli_session_id": session_id,
        }
        state = jwt.encode(payload, STATE_JWT_SECRET, algorithm="HS256")
        auth_url = await oidc_service.get_authorization_url_for_cli(state, nonce)

        logger.info(f"CLI OIDC login initialized: session_id={session_id}")
        return CLILoginInitResponse(auth_url=auth_url, session_id=session_id)

    except Exception as e:
        logger.error(f"CLI OIDC login init failed: {e}")
        raise HTTPException(
            status_code=500, detail=f"Failed to initialize OIDC login: {e}"
        )


@router.get("/cli-callback")
async def cli_oidc_callback(
    code: str = Query(..., description="Authorization code"),
    state: str = Query(..., description="State parameter"),
    error: str = Query(None, description="Error information"),
    db: Session = Depends(get_db),
):
    """
    CLI OIDC callback handler.

    Handles OIDC provider callback for CLI login, stores token in Redis session.
    """
    # Decode state to get session_id
    try:
        payload = jwt.decode(state, STATE_JWT_SECRET, algorithms=["HS256"])
        nonce = payload["nonce"]
        session_id = payload.get("cli_session_id")
        now = int(time.time())

        if now > payload["exp"]:
            logger.error(f"CLI callback: State parameter expired")
            return _cli_callback_error_page("Login session expired. Please try again.")

        if not session_id:
            logger.error("CLI callback: Missing session_id in state")
            return _cli_callback_error_page("Invalid login session.")

    except Exception as e:
        logger.error(f"CLI callback: Invalid state parameter: {e}")
        return _cli_callback_error_page("Invalid login session.")

    session_key = f"{CLI_SESSION_KEY_PREFIX}{session_id}"

    if error:
        logger.error(f"CLI OIDC callback error: {error}")
        await cache_manager.set(
            session_key,
            {"status": "failed", "error": error},
            expire=CLI_SESSION_EXPIRE_SECONDS,
        )
        return _cli_callback_error_page(f"Authentication failed: {error}")

    try:
        tokens = await oidc_service.exchange_code_for_tokens(code, state)

        id_token = tokens.get("id_token")
        if not id_token:
            raise Exception("Missing ID Token in response")

        claims = await oidc_service.verify_id_token(id_token, nonce)

        # Get user information
        access_token = tokens.get("access_token")
        user_info = {}
        if access_token:
            user_info = await oidc_service.get_user_info(access_token)

        user_data = {**claims, **user_info}

        user_id = user_data.get("sub")
        email = (
            user_data.get("email")
            or user_data.get("preferred_username")
            or f"{user_id}@unknown.email"
        )

        if not user_id:
            raise Exception("Missing user identifier in ID Token")

        # Find or create user
        user_name = email.split("@")[0] if "@" in email else user_id
        user = db.scalar(select(User).where(User.user_name == user_name))

        if not user:
            from app.core import security

            user = User(
                user_name=user_name,
                email=email,
                is_active=True,
                password_hash=security.get_password_hash(str(uuid.uuid4())),
                git_info=[],
                auth_source="oidc",
            )
            db.add(user)
            db.commit()
            db.refresh(user)
            logger.info(f"Created new OIDC user via CLI: user_name={user.user_name}")

            # Apply default resources synchronously for new CLI OIDC users
            apply_default_resources_sync(user.id)
        else:
            if user.email != email:
                user.email = email
            if user.auth_source == "unknown":
                user.auth_source = "oidc"
            db.commit()
            db.refresh(user)

        if not user.is_active:
            raise Exception("User not active")

        jwt_token = create_access_token(data={"sub": user.user_name})

        # Store token in Redis session
        await cache_manager.set(
            session_key,
            {
                "status": "success",
                "access_token": jwt_token,
                "username": user.user_name,
            },
            expire=CLI_SESSION_EXPIRE_SECONDS,
        )

        logger.info(f"CLI OIDC login success: user_name={user.user_name}")
        return _cli_callback_success_page()

    except Exception as e:
        logger.error(f"CLI OIDC callback processing failed: {e}")
        await cache_manager.set(
            session_key,
            {"status": "failed", "error": str(e)},
            expire=CLI_SESSION_EXPIRE_SECONDS,
        )
        return _cli_callback_error_page(f"Authentication failed: {str(e)}")


@router.get("/cli-poll", response_model=CLIPollResponse)
async def cli_poll_token(
    session_id: str = Query(..., description="CLI login session ID"),
):
    """
    Poll for CLI login token.

    CLI polls this endpoint to check if OIDC authentication is complete.
    """
    session_key = f"{CLI_SESSION_KEY_PREFIX}{session_id}"
    session_data = await cache_manager.get(session_key)

    if not session_data:
        return CLIPollResponse(status="failed", error="Session expired or not found")

    status = session_data.get("status", "pending")

    if status == "pending":
        return CLIPollResponse(status="pending")
    elif status == "success":
        return CLIPollResponse(
            status="success",
            access_token=session_data.get("access_token"),
            username=session_data.get("username"),
        )
    else:
        return CLIPollResponse(status="failed", error=session_data.get("error"))


def _cli_callback_success_page() -> HTMLResponse:
    """Generate HTML page for successful CLI login."""
    html_content = """
    <!DOCTYPE html>
    <html>
    <head>
        <title>Login Successful</title>
        <style>
            body {
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                display: flex;
                justify-content: center;
                align-items: center;
                height: 100vh;
                margin: 0;
                background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            }
            .container {
                text-align: center;
                background: white;
                padding: 40px 60px;
                border-radius: 16px;
                box-shadow: 0 10px 40px rgba(0,0,0,0.2);
            }
            .success-icon {
                font-size: 64px;
                margin-bottom: 20px;
            }
            h1 {
                color: #10b981;
                margin-bottom: 10px;
            }
            p {
                color: #666;
                font-size: 16px;
            }
        </style>
    </head>
    <body>
        <div class="container">
            <div class="success-icon">✓</div>
            <h1>Login Successful!</h1>
            <p>You can now close this window and return to the terminal.</p>
        </div>
    </body>
    </html>
    """
    return HTMLResponse(content=html_content)


def _cli_callback_error_page(error_message: str) -> HTMLResponse:
    """Generate HTML page for failed CLI login."""
    html_content = f"""
    <!DOCTYPE html>
    <html>
    <head>
        <title>Login Failed</title>
        <style>
            body {{
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                display: flex;
                justify-content: center;
                align-items: center;
                height: 100vh;
                margin: 0;
                background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            }}
            .container {{
                text-align: center;
                background: white;
                padding: 40px 60px;
                border-radius: 16px;
                box-shadow: 0 10px 40px rgba(0,0,0,0.2);
            }}
            .error-icon {{
                font-size: 64px;
                margin-bottom: 20px;
            }}
            h1 {{
                color: #ef4444;
                margin-bottom: 10px;
            }}
            p {{
                color: #666;
                font-size: 16px;
            }}
        </style>
    </head>
    <body>
        <div class="container">
            <div class="error-icon">✗</div>
            <h1>Login Failed</h1>
            <p>{error_message}</p>
            <p>Please close this window and try again.</p>
        </div>
    </body>
    </html>
    """
    return HTMLResponse(content=html_content)
