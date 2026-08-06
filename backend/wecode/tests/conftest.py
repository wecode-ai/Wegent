# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Shared pytest fixtures for WeCode tests."""

import pytest

from app.models.user import User
from tests.conftest import (
    test_admin_api_key,
    test_admin_token,
    test_admin_user,
    test_api_key,
    test_client,
    test_db,
    test_engine,
    test_session_factory,
    test_token,
    test_user,
    worker_id,
)
from wecode.config.external_knowledge_config import external_knowledge_settings
from wecode.models.erp_user import WecodeErpUser


@pytest.fixture
def auth_headers(test_token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {test_token}"}


@pytest.fixture
def configure_external_knowledge(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(
        external_knowledge_settings, "AP_KNOWLEDGE_SYSTEM_TOKEN", "service-token"
    )
    monkeypatch.setattr(
        external_knowledge_settings,
        "AP_KNOWLEDGE_IFRAME_HOSTS",
        {"apgateway.erp.sina.com.cn"},
    )


@pytest.fixture
def erp_profile(test_db, test_user: User) -> WecodeErpUser:
    profile = WecodeErpUser(
        user_id=test_user.id,
        employee_id="230473",
        department_name="Engineering",
        erp_name="Test User",
        email=test_user.email,
    )
    test_db.add(profile)
    test_db.commit()
    return profile
