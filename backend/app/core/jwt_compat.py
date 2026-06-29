# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""JWT decode helpers that support short-lived signing key rotation."""

from __future__ import annotations

import logging
from typing import Any, Sequence

import jwt as pyjwt
from jose import jwt as jose_jwt
from jose.exceptions import JWTError

from app.core.config import settings

logger = logging.getLogger(__name__)


def get_jwt_decode_secret_keys() -> list[str]:
    """Return the active secret followed by configured legacy decode-only secrets."""
    keys = [settings.SECRET_KEY]
    for key in settings.JWT_LEGACY_SECRET_KEYS.split(","):
        normalized_key = key.strip()
        if normalized_key and normalized_key not in keys:
            keys.append(normalized_key)
    return keys


def _log_legacy_secret_usage(secret_index: int) -> None:
    if secret_index > 0:
        logger.info("JWT verified with legacy secret key index=%s", secret_index)


def decode_jose_jwt(
    token: str,
    *,
    algorithms: Sequence[str] | None = None,
    options: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Decode a python-jose JWT with the active secret, then legacy secrets."""
    last_error: JWTError | None = None
    for secret_index, secret_key in enumerate(get_jwt_decode_secret_keys()):
        try:
            payload = jose_jwt.decode(
                token,
                secret_key,
                algorithms=list(algorithms or [settings.ALGORITHM]),
                options=options,
            )
            _log_legacy_secret_usage(secret_index)
            return payload
        except JWTError as exc:
            last_error = exc
    if last_error:
        raise last_error
    raise JWTError("No JWT secret keys configured")


def decode_pyjwt(
    token: str,
    *,
    algorithms: Sequence[str] | None = None,
    options: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Decode a PyJWT token with the active secret, then legacy secrets."""
    last_error: pyjwt.InvalidTokenError | None = None
    for secret_index, secret_key in enumerate(get_jwt_decode_secret_keys()):
        try:
            payload = pyjwt.decode(
                token,
                secret_key,
                algorithms=list(algorithms or [settings.ALGORITHM]),
                options=options,
            )
            _log_legacy_secret_usage(secret_index)
            return payload
        except pyjwt.InvalidTokenError as exc:
            last_error = exc
    if last_error:
        raise last_error
    raise pyjwt.InvalidTokenError("No JWT secret keys configured")
