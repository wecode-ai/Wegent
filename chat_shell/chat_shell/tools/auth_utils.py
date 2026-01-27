# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Authentication utilities for backend API calls.

This module provides helper functions for adding JWT authentication
to HTTP requests made to backend internal APIs.
"""

import logging
from typing import Dict

from chat_shell.core.config import settings

logger = logging.getLogger(__name__)


def get_backend_auth_headers() -> Dict[str, str]:
    """
    Get authentication headers for backend internal API calls.

    Returns JWT token from REMOTE_STORAGE_TOKEN setting in Authorization header.
    This token is used to authenticate chat_shell service when calling backend
    internal API endpoints.

    Returns:
        Dictionary of HTTP headers including Authorization header with JWT token.
        If token is not configured, returns empty dict (requests will fail with 401).

    Example:
        >>> headers = get_backend_auth_headers()
        >>> async with httpx.AsyncClient(headers=headers) as client:
        >>>     response = await client.get(backend_url)
    """
    headers = {}

    # Get JWT token from settings
    # Priority: REMOTE_STORAGE_TOKEN (primary) > INTERNAL_SERVICE_TOKEN (fallback)
    auth_token = getattr(settings, "REMOTE_STORAGE_TOKEN", "")
    if not auth_token:
        auth_token = getattr(settings, "INTERNAL_SERVICE_TOKEN", "")

    if auth_token:
        headers["Authorization"] = f"Bearer {auth_token}"
        logger.debug("[auth_utils] Added JWT token to Authorization header")
    else:
        logger.warning(
            "[auth_utils] No JWT token configured (REMOTE_STORAGE_TOKEN or INTERNAL_SERVICE_TOKEN). "
            "Backend internal API calls will fail with 401 Unauthorized."
        )

    return headers
