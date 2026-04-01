# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for skill identity token authentication."""

import jwt

from app.core.config import settings
from app.services.auth import create_skill_identity_token, verify_skill_identity_token


class TestCreateSkillIdentityToken:
    """Tests for create_skill_identity_token function."""

    def test_create_and_verify_skill_identity_token(self):
        """A created token should round-trip into token info."""
        token = create_skill_identity_token(
            user_id=7,
            user_name="alice",
            runtime_type="executor",
            runtime_name="executor-1",
        )

        info = verify_skill_identity_token(token)

        assert info is not None
        assert info.user_id == 7
        assert info.user_name == "alice"
        assert info.runtime_type == "executor"
        assert info.runtime_name == "executor-1"

    def test_create_skill_identity_token_uses_configured_expiration(self, monkeypatch):
        """Created token should include expiration from configuration."""
        monkeypatch.setattr(settings, "SKILL_IDENTITY_TOKEN_EXPIRE_MINUTES", 15)

        token = create_skill_identity_token(
            user_id=7,
            user_name="alice",
            runtime_type="executor",
            runtime_name="executor-1",
        )

        payload = jwt.decode(
            token, settings.SECRET_KEY, algorithms=[settings.ALGORITHM]
        )

        assert payload["exp"] - payload["iat"] == 15 * 60


class TestVerifySkillIdentityToken:
    """Tests for verify_skill_identity_token function."""

    def test_verify_invalid_skill_identity_token(self):
        """Invalid token strings should be rejected."""
        assert verify_skill_identity_token("invalid-token") is None

    def test_verify_expired_skill_identity_token(self, monkeypatch):
        """Expired skill identity tokens should be rejected."""
        monkeypatch.setattr(settings, "SKILL_IDENTITY_TOKEN_EXPIRE_MINUTES", -1)

        token = create_skill_identity_token(
            user_id=7,
            user_name="alice",
            runtime_type="executor",
            runtime_name="executor-1",
        )

        assert verify_skill_identity_token(token) is None
