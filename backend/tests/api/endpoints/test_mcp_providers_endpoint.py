# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import json
from unittest.mock import Mock

import pytest

import app.api.endpoints.mcp_providers as mcp_providers_endpoint
from app.schemas.mcp_providers import MCPProviderKeysRequest
from shared.utils.crypto import is_data_encrypted


class DummyUser:
    def __init__(self, preferences: str):
        self.preferences = preferences
        self.id = 1


@pytest.mark.anyio
async def test_update_mcp_provider_keys_encrypts_values(monkeypatch):
    captured = {}

    def _fake_update_current_user(*, db, user, obj_in):  # noqa: ARG001
        captured["obj_in"] = obj_in
        return user

    monkeypatch.setattr(
        mcp_providers_endpoint.user_service,
        "update_current_user",
        _fake_update_current_user,
    )

    request = MCPProviderKeysRequest(mcp_router="plain-router-token")
    current_user = DummyUser(preferences=json.dumps({}))

    response = await mcp_providers_endpoint.update_mcp_provider_keys(
        keys=request,
        db=Mock(),
        current_user=current_user,
    )

    saved_keys = captured["obj_in"].preferences.mcp_provider_keys

    assert response.success is True
    assert saved_keys is not None
    assert saved_keys.mcp_router != "plain-router-token"
    assert is_data_encrypted(saved_keys.mcp_router)
