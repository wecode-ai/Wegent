# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import json
import time

import jwt
import pytest

from app.api.endpoints import oidc
from app.core.security import get_password_hash
from app.models.user import User


def _state_token() -> str:
    now = int(time.time())
    return jwt.encode(
        {
            "nonce": "test-nonce",
            "iat": now,
            "exp": now + 60,
        },
        oidc.STATE_JWT_SECRET,
        algorithm="HS256",
    )


@pytest.mark.asyncio
async def test_oidc_callback_saves_employee_id_for_existing_user(test_db, monkeypatch):
    user = User(
        user_name="zhangsan",
        email="zhangsan@corp.example",
        password_hash=get_password_hash("password"),
        is_active=True,
        git_info=[],
        auth_source="oidc",
        preferences=json.dumps({"send_key": "cmd_enter"}),
    )
    test_db.add(user)
    test_db.commit()

    async def fake_exchange_code_for_tokens(code, state):
        return {"id_token": "id-token", "access_token": "access-token"}

    async def fake_verify_id_token(id_token, nonce):
        return {"sub": "dex-sub"}

    async def fake_get_user_info(access_token):
        return {
            "userid": "10086",
            "email": "zhangsan@corp.example",
            "name": "Zhang San",
        }

    monkeypatch.setattr(
        oidc.oidc_service, "exchange_code_for_tokens", fake_exchange_code_for_tokens
    )
    monkeypatch.setattr(oidc.oidc_service, "verify_id_token", fake_verify_id_token)
    monkeypatch.setattr(oidc.oidc_service, "get_user_info", fake_get_user_info)
    monkeypatch.setattr(oidc, "apply_default_resources_sync", lambda user_id: None)

    await oidc.oidc_callback(code="code", state=_state_token(), error=None, db=test_db)

    test_db.refresh(user)
    prefs = json.loads(user.preferences)
    assert prefs["employee_id"] == "10086"
    assert prefs["send_key"] == "cmd_enter"
    assert test_db.query(User).count() == 1


@pytest.mark.asyncio
async def test_oidc_callback_saves_employee_id_for_new_user(test_db, monkeypatch):
    async def fake_exchange_code_for_tokens(code, state):
        return {"id_token": "id-token", "access_token": "access-token"}

    async def fake_verify_id_token(id_token, nonce):
        return {"sub": "dex-sub"}

    async def fake_get_user_info(access_token):
        return {
            "userid": "10087",
            "email": "lisi@corp.example",
            "name": "Li Si",
        }

    monkeypatch.setattr(
        oidc.oidc_service, "exchange_code_for_tokens", fake_exchange_code_for_tokens
    )
    monkeypatch.setattr(oidc.oidc_service, "verify_id_token", fake_verify_id_token)
    monkeypatch.setattr(oidc.oidc_service, "get_user_info", fake_get_user_info)
    monkeypatch.setattr(oidc, "apply_default_resources_sync", lambda user_id: None)

    await oidc.oidc_callback(code="code", state=_state_token(), error=None, db=test_db)

    user = test_db.query(User).filter(User.user_name == "lisi").one()
    assert json.loads(user.preferences)["employee_id"] == "10087"
