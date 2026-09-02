# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Short-lived Backend upload links for marketplace submissions."""

import secrets
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Literal
from urllib.parse import urlencode, urlparse

from jose import JWTError, jwt

from app.core.config import settings

MarketplaceSubmissionKind = Literal["plugin", "smart_app"]


class InvalidMarketplaceSubmissionUploadToken(ValueError):
    """Raised when a marketplace submission upload token is invalid or expired."""


@dataclass(frozen=True)
class MarketplaceSubmissionUploadClaims:
    kind: MarketplaceSubmissionKind
    submission_id: int
    user_id: int


def build_marketplace_submission_upload_url(
    *,
    kind: MarketplaceSubmissionKind,
    submission_id: int,
    user_id: int,
) -> tuple[str, datetime]:
    """Create a scoped Backend URL for one submission upload."""
    now = datetime.now(timezone.utc)
    expires_at = now + timedelta(seconds=settings.PLUGIN_PACKAGE_URL_EXPIRES_SECONDS)
    payload = {
        "kind": kind,
        "submission_id": submission_id,
        "user_id": user_id,
        "purpose": "marketplace_submission_artifact_upload",
        "nonce": secrets.token_urlsafe(16),
        "iat": now,
        "exp": expires_at,
    }
    token = jwt.encode(payload, settings.SECRET_KEY, algorithm=settings.ALGORITHM)
    resource = "plugins" if kind == "plugin" else "smart-apps"
    api_prefix = settings.API_PREFIX.rstrip("/")
    path = f"{api_prefix}/{resource}/submissions/{submission_id}/artifact"
    relative_url = f"{path}?{urlencode({'token': token})}"
    public_backend_url = settings.WEGENT_BACKEND_PUBLIC_URL.strip().rstrip("/")
    parsed_backend_url = urlparse(public_backend_url)
    is_loopback_http = parsed_backend_url.scheme == "http" and (
        parsed_backend_url.hostname in {"127.0.0.1", "localhost", "::1"}
    )
    if parsed_backend_url.scheme == "https" or is_loopback_http:
        return f"{public_backend_url}{relative_url}", expires_at
    return relative_url, expires_at


def verify_marketplace_submission_upload_token(
    token: str,
    *,
    expected_kind: MarketplaceSubmissionKind,
) -> MarketplaceSubmissionUploadClaims:
    """Verify a submission upload token and return its scoped identities."""
    try:
        payload = jwt.decode(
            token,
            settings.SECRET_KEY,
            algorithms=[settings.ALGORITHM],
        )
    except JWTError as exc:
        raise InvalidMarketplaceSubmissionUploadToken(
            "Invalid marketplace submission upload token"
        ) from exc

    kind = payload.get("kind")
    submission_id = payload.get("submission_id")
    user_id = payload.get("user_id")
    if (
        payload.get("purpose") != "marketplace_submission_artifact_upload"
        or kind != expected_kind
        or type(submission_id) is not int
        or type(user_id) is not int
        or not payload.get("nonce")
    ):
        raise InvalidMarketplaceSubmissionUploadToken(
            "Invalid marketplace submission upload token payload"
        )

    return MarketplaceSubmissionUploadClaims(
        kind=expected_kind,
        submission_id=submission_id,
        user_id=user_id,
    )
