# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for simplified-OAuth MCP access tokens."""

import jwt
import pytest

from app.core.config import settings
from app.services.auth import (
    MCP_SCOPE_USERINFO,
    MCP_TOKEN_AUDIENCE,
    MCP_TOKEN_TYPE,
    McpTokenScopeError,
    create_mcp_token,
    create_skill_identity_token,
    parse_scopes,
    verify_mcp_token,
)


class TestCreateMcpToken:
    """Tests for create_mcp_token."""

    def test_create_and_verify_round_trip(self):
        token = create_mcp_token(user_id=7, user_name="alice")

        info = verify_mcp_token(token)

        assert info is not None
        assert info.user_id == 7
        assert info.user_name == "alice"
        assert info.scopes == frozenset({MCP_SCOPE_USERINFO})
        assert info.audience == MCP_TOKEN_AUDIENCE
        assert info.task_id is None
        assert info.subtask_id is None

    def test_created_token_carries_audience_scope_and_lifetime(self, monkeypatch):
        monkeypatch.setattr(settings, "MCP_TOKEN_EXPIRE_MINUTES", 15)

        token = create_mcp_token(user_id=7, user_name="alice")

        payload = jwt.decode(
            token,
            settings.SECRET_KEY,
            algorithms=[settings.ALGORITHM],
            audience=MCP_TOKEN_AUDIENCE,
        )
        assert payload["type"] == MCP_TOKEN_TYPE
        assert payload["sub"] == "alice"
        assert payload["scope"] == MCP_SCOPE_USERINFO
        assert payload["exp"] - payload["iat"] == 15 * 60

    def test_task_binding_is_optional(self):
        token = create_mcp_token(
            user_id=7,
            user_name="alice",
            task_id=11,
            subtask_id=22,
        )

        info = verify_mcp_token(token)

        assert info is not None
        assert info.task_id == 11
        assert info.subtask_id == 22

    def test_unknown_scope_is_rejected(self):
        with pytest.raises(McpTokenScopeError):
            create_mcp_token(
                user_id=7,
                user_name="alice",
                scopes={"mcp:admin.everything"},
            )

    def test_empty_scope_is_rejected(self):
        with pytest.raises(McpTokenScopeError):
            create_mcp_token(user_id=7, user_name="alice", scopes=set())


class TestVerifyMcpToken:
    """Tests for verify_mcp_token."""

    def test_invalid_token_is_rejected(self):
        assert verify_mcp_token("not-a-token") is None

    def test_expired_token_is_rejected(self):
        token = create_mcp_token(user_id=7, user_name="alice", expires_delta_minutes=-1)

        assert verify_mcp_token(token) is None

    def test_other_audience_is_rejected(self):
        token = create_mcp_token(user_id=7, user_name="alice")

        assert verify_mcp_token(token, audience="wegent-connector-runtime") is None

    def test_other_token_types_are_rejected(self):
        skill_identity = create_skill_identity_token(
            user_id=7,
            user_name="alice",
            runtime_type="executor",
            runtime_name="executor-1",
        )

        assert verify_mcp_token(skill_identity) is None

    def test_missing_required_scope_is_rejected(self):
        token = create_mcp_token(user_id=7, user_name="alice")

        assert verify_mcp_token(token, required_scope="mcp:tools.invoke") is None
        assert verify_mcp_token(token, required_scope=MCP_SCOPE_USERINFO) is not None


class TestParseScopes:
    """Tests for parse_scopes."""

    def test_parses_space_delimited_scopes(self):
        assert parse_scopes(MCP_SCOPE_USERINFO) == frozenset({MCP_SCOPE_USERINFO})

    def test_rejects_empty_and_unknown_scopes(self):
        with pytest.raises(McpTokenScopeError):
            parse_scopes("   ")
        with pytest.raises(McpTokenScopeError):
            parse_scopes("mcp:nothing")
