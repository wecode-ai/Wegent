# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Authentication middleware for internal service endpoints."""

from __future__ import annotations

import secrets
from typing import Optional

from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from knowledge_runtime.config import get_settings

# HTTPBearer security scheme for OpenAPI documentation
security = HTTPBearer(auto_error=False)


def require_internal_service_token_configured() -> None:
    """Fail startup when protected internal endpoints cannot authenticate."""
    settings = get_settings()
    if settings.internal_service_token:
        return

    raise RuntimeError(
        "INTERNAL_SERVICE_TOKEN is required for Knowledge Runtime internal API "
        "authentication. Generate one with `openssl rand -hex 32` and configure "
        "the same value for Backend and Knowledge Runtime."
    )


def verify_internal_token(
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(security),
) -> None:
    """Verify internal service authentication token.

    This dependency checks for a valid Bearer token in the Authorization header.
    If INTERNAL_SERVICE_TOKEN is not configured, requests are rejected so internal
    endpoints fail closed.

    Args:
        credentials: The Bearer token credentials from the Authorization header.

    Raises:
        HTTPException: 401 Unauthorized if token is missing or invalid.
    """
    settings = get_settings()
    expected_token = settings.internal_service_token

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
    if not secrets.compare_digest(provided_token, expected_token):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid authentication token",
            headers={"WWW-Authenticate": "Bearer"},
        )
