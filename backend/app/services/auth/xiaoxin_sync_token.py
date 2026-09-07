# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Authentication dependency for Xiaoxin knowledge-sync notifications."""

from __future__ import annotations

import hmac
from typing import Annotated

from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from app.core.config import settings

xiaoxin_sync_bearer = HTTPBearer(auto_error=False)


def verify_xiaoxin_sync_token(
    credentials: Annotated[
        HTTPAuthorizationCredentials | None, Depends(xiaoxin_sync_bearer)
    ],
) -> None:
    """Fail closed unless the dedicated Xiaoxin Bearer token matches."""
    expected_token = (settings.XIAOXIN_SYNC_TOKEN or "").strip()
    provided_token = credentials.credentials if credentials is not None else ""
    if not expected_token or not hmac.compare_digest(provided_token, expected_token):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Unauthorized",
            headers={"WWW-Authenticate": "Bearer"},
        )
