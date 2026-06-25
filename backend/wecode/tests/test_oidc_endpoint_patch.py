# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import json
import time

import jwt
import pytest
from fastapi import BackgroundTasks

from app.api.endpoints import oidc
from app.core.security import get_password_hash
from app.models.user import User
from wecode.api import oidc_endpoint_patch
from wecode.service import erp_client as erp_client_module
from wecode.service.erp_client import EmployeeInfo


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
async def test_patched_oidc_callback_stores_employee_id_without_user_lookup(
    test_db, monkeypatch
):
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
            "email": "zhangsan@corp.example",
            "name": "Zhang San",
        }

    monkeypatch.setattr(
        oidc_endpoint_patch.oidc_service,
        "exchange_code_for_tokens",
        fake_exchange_code_for_tokens,
    )
    monkeypatch.setattr(
        oidc_endpoint_patch.oidc_service, "verify_id_token", fake_verify_id_token
    )
    monkeypatch.setattr(
        oidc_endpoint_patch.oidc_service, "get_user_info", fake_get_user_info
    )
    monkeypatch.setattr(
        erp_client_module.erp_client,
        "search_employee",
        lambda _: EmployeeInfo(
            ssn="10086",
            name="Zhang San",
            email="zhangsan@corp.example",
            department="Engineering",
        ),
    )

    response = await oidc_endpoint_patch._patched_oidc_callback(
        BackgroundTasks(),
        code="code",
        state=_state_token(),
        error=None,
        db=test_db,
    )

    test_db.refresh(user)
    prefs = json.loads(user.preferences)
    assert "login_success=true" in response.headers["location"]
    assert "employee_id" not in prefs
    assert prefs["company_profile"] == {
        "employee_id": "10086",
        "name": "Zhang San",
    }
    assert prefs["send_key"] == "cmd_enter"
