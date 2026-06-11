# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Internal service token verification for service-to-service endpoints.

Provides FastAPI dependency that validates INTERNAL_SERVICE_TOKEN in
Authorization headers. Used to secure /internal/* endpoints so only
trusted services (chat_shell, knowledge_runtime) can call them.
"""

from __future__ import annotations

import hmac
from typing import Optional

from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from app.core.config import settings
from shared.telemetry.decorators import trace_sync

# HTTPBearer security scheme for OpenAPI documentation
security = HTTPBearer(auto_error=False)


def _normalized_internal_service_token() -> str:
    return (settings.INTERNAL_SERVICE_TOKEN or "").strip()


@trace_sync()
def require_internal_service_token_configured() -> None:
    """Fail startup when protected internal endpoints cannot authenticate."""
    if _normalized_internal_service_token():
        return

    raise RuntimeError(
        "INTERNAL_SERVICE_TOKEN is required for Backend internal API authentication. "
        "Generate one with `openssl rand -hex 32` and configure the same value for "
        "Backend, Chat Shell, Knowledge Runtime, and Knowledge Doc Converter."
    )


def verify_internal_service_token(
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(security),
) -> None:
    """Verify internal service authentication token.

    This dependency checks for a valid Bearer token in the Authorization header.
    If INTERNAL_SERVICE_TOKEN is not configured (empty string), requests are
    rejected so internal endpoints fail closed.

    Args:
        credentials: The Bearer token credentials from the Authorization header.

    Raises:
        HTTPException: 401 Unauthorized if token is missing or invalid.
    """
    expected_token = _normalized_internal_service_token()

    if not expected_token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Internal service token is not configured",
            headers={"WWW-Authenticate": "Bearer"},
        )

    # Check if credentials are provided
    if credentials is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing authentication token",
            headers={"WWW-Authenticate": "Bearer"},
        )

    # Use constant-time comparison to prevent timing attacks
    provided_token = credentials.credentials
    if not hmac.compare_digest(provided_token, expected_token):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid authentication token",
            headers={"WWW-Authenticate": "Bearer"},
        )
