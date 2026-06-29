# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import logging

import jwt as pyjwt
from jose import jwt as jose_jwt

from app.core.config import settings
from app.core.jwt_compat import decode_jose_jwt, decode_pyjwt


def test_decode_jose_jwt_logs_legacy_secret_usage(monkeypatch, caplog):
    legacy_secret_key = "your-secret-key-here"
    monkeypatch.setattr(settings, "SECRET_KEY", "new-secret-key-for-tests")
    monkeypatch.setattr(settings, "JWT_LEGACY_SECRET_KEYS", legacy_secret_key)
    token = jose_jwt.encode(
        {"sub": "testuser"}, legacy_secret_key, algorithm=settings.ALGORITHM
    )

    with caplog.at_level(logging.INFO, logger="app.core.jwt_compat"):
        payload = decode_jose_jwt(token)

    assert payload["sub"] == "testuser"
    assert "JWT verified with legacy secret key" in caplog.text


def test_decode_pyjwt_logs_legacy_secret_usage(monkeypatch, caplog):
    legacy_secret_key = "your-secret-key-here"
    monkeypatch.setattr(settings, "SECRET_KEY", "new-secret-key-for-tests")
    monkeypatch.setattr(settings, "JWT_LEGACY_SECRET_KEYS", legacy_secret_key)
    token = pyjwt.encode(
        {"type": "task_token"}, legacy_secret_key, algorithm=settings.ALGORITHM
    )

    with caplog.at_level(logging.INFO, logger="app.core.jwt_compat"):
        payload = decode_pyjwt(token)

    assert payload["type"] == "task_token"
    assert "JWT verified with legacy secret key" in caplog.text
