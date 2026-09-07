# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import jwt
import pytest

from app.core.config import settings
from app.services.auth import (
    MCP_IDENTITY_TOKEN_TYPE,
    create_mcp_identity_token,
    create_skill_identity_token,
    verify_mcp_identity_token,
)


def test_create_and_verify_mcp_identity_token() -> None:
    token = create_mcp_identity_token(
        user_id=7, user_name="alice", server_name="business-server"
    )

    info = verify_mcp_identity_token(token)

    assert info is not None
    assert info.user_id == 7
    assert info.user_name == "alice"
    assert info.server_name == "business-server"


def test_mcp_identity_token_expires_with_dedicated_ttl() -> None:
    token = create_mcp_identity_token(
        user_id=7, user_name="alice", server_name="business-server"
    )

    payload = jwt.decode(
        token,
        settings.SECRET_KEY,
        algorithms=[settings.ALGORITHM],
    )

    assert payload["type"] == MCP_IDENTITY_TOKEN_TYPE
    assert payload["exp"] - payload["iat"] == pytest.approx(
        settings.MCP_IDENTITY_TOKEN_EXPIRE_MINUTES * 60
    )


def test_verify_mcp_identity_token_rejects_skill_identity_token() -> None:
    token = create_skill_identity_token(
        user_id=7, user_name="alice", runtime_type="executor", runtime_name="x"
    )

    assert verify_mcp_identity_token(token) is None


def test_verify_mcp_identity_token_rejects_invalid_token() -> None:
    assert verify_mcp_identity_token("not-a-jwt") is None
