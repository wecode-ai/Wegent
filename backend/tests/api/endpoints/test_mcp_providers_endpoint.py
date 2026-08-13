# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import json
from typing import Any
from unittest.mock import Mock

import pytest
from sqlalchemy.orm import Session

import app.api.endpoints.mcp_providers as mcp_providers_endpoint
from app.models.user import User
from app.schemas.mcp_providers import MCPProviderKeysRequest
from app.schemas.user import UserUpdate
from shared.utils.crypto import is_data_encrypted


class DummyUser:
    def __init__(self, preferences: str) -> None:
        self.preferences = preferences
        self.id = 1


@pytest.fixture
def captured_user_update(
    monkeypatch: pytest.MonkeyPatch,
) -> dict[str, UserUpdate]:
    captured: dict[str, UserUpdate] = {}

    def _fake_update_current_user(
        *,
        db: Session,
        user: User,
        obj_in: UserUpdate,
        **_: Any,
    ) -> User:
        del db
        captured["obj_in"] = obj_in
        return user

    monkeypatch.setattr(
        mcp_providers_endpoint.user_service,
        "update_current_user",
        _fake_update_current_user,
    )
    return captured


@pytest.mark.anyio
async def test_update_mcp_provider_keys_encrypts_values(
    captured_user_update: dict[str, UserUpdate],
) -> None:
    request = MCPProviderKeysRequest(mcp_router="plain-router-token")
    current_user = DummyUser(preferences=json.dumps({}))

    response = await mcp_providers_endpoint.update_mcp_provider_keys(
        keys=request,
        db=Mock(),
        current_user=current_user,
    )

    saved_keys = captured_user_update["obj_in"].preferences.mcp_provider_keys

    assert response.success is True
    assert saved_keys is not None
    assert saved_keys.mcp_router != "plain-router-token"
    assert is_data_encrypted(saved_keys.mcp_router)


@pytest.mark.anyio
async def test_update_mcp_provider_keys_preserves_dynamic_fields(
    captured_user_update: dict[str, UserUpdate],
) -> None:
    request = MCPProviderKeysRequest(custom_provider="new-token")
    current_user = DummyUser(
        preferences=json.dumps(
            {"mcp_provider_keys": {"existing_provider": "existing-token"}}
        )
    )

    response = await mcp_providers_endpoint.update_mcp_provider_keys(
        keys=request,
        db=Mock(),
        current_user=current_user,
    )

    saved_keys = captured_user_update["obj_in"].preferences.mcp_provider_keys
    saved_values = saved_keys.model_dump()

    assert response.success is True
    assert is_data_encrypted(saved_values["custom_provider"])
    assert is_data_encrypted(saved_values["existing_provider"])
