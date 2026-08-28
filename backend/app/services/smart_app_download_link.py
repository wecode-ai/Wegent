# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Short-lived Backend download links for Smart app artifacts."""

import secrets
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from urllib.parse import urlencode

from jose import JWTError, jwt

from app.core.config import settings


class InvalidSmartAppDownloadToken(ValueError):
    """Raised when a Smart app artifact token is invalid or expired."""


@dataclass(frozen=True)
class SmartAppDownloadClaims:
    smart_app_id: int
    release_id: int
    user_id: int


def build_smart_app_download_url(
    *,
    smart_app_id: int,
    release_id: int,
    user_id: int,
) -> tuple[str, datetime]:
    """Create a scoped relative Backend URL for one Smart app release."""
    now = datetime.now(timezone.utc)
    expires_at = now + timedelta(seconds=settings.PLUGIN_PACKAGE_URL_EXPIRES_SECONDS)
    payload = {
        "smart_app_id": smart_app_id,
        "release_id": release_id,
        "user_id": user_id,
        "purpose": "smart_app_artifact_download",
        "nonce": secrets.token_urlsafe(16),
        "iat": now,
        "exp": expires_at,
    }
    token = jwt.encode(payload, settings.SECRET_KEY, algorithm=settings.ALGORITHM)
    query = urlencode({"token": token})
    api_prefix = settings.API_PREFIX.rstrip("/")
    path = f"{api_prefix}/smart-apps/marketplace/{smart_app_id}/artifact"
    return f"{path}?{query}", expires_at


def verify_smart_app_download_token(token: str) -> SmartAppDownloadClaims:
    """Verify a Smart app artifact token and return its scoped identities."""
    try:
        payload = jwt.decode(
            token,
            settings.SECRET_KEY,
            algorithms=[settings.ALGORITHM],
        )
    except JWTError as exc:
        raise InvalidSmartAppDownloadToken("Invalid Smart app download token") from exc

    smart_app_id = payload.get("smart_app_id")
    release_id = payload.get("release_id")
    user_id = payload.get("user_id")
    if (
        payload.get("purpose") != "smart_app_artifact_download"
        or type(smart_app_id) is not int
        or type(release_id) is not int
        or type(user_id) is not int
        or not payload.get("nonce")
    ):
        raise InvalidSmartAppDownloadToken("Invalid Smart app download token payload")

    return SmartAppDownloadClaims(
        smart_app_id=smart_app_id,
        release_id=release_id,
        user_id=user_id,
    )
