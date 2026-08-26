# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""API coverage for explicit device Git credential synchronization."""

from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.api.endpoints.devices import router as devices_router
from app.api.endpoints.users import router as users_router
from app.core import security
from app.models.user import User


@pytest.fixture
def git_credentials_client(test_db: Session, test_user: User) -> TestClient:
    app = FastAPI()
    app.include_router(users_router, prefix="/api/users")
    app.include_router(devices_router, prefix="/api/devices")

    def override_get_db():
        yield test_db

    app.dependency_overrides[get_db] = override_get_db
    app.dependency_overrides[security.get_current_user] = lambda: test_user
    app.dependency_overrides[security.get_current_user_optional] = lambda: test_user
    return TestClient(app)


@pytest.mark.api
def test_sync_summary_never_returns_git_tokens(
    git_credentials_client: TestClient,
    test_db: Session,
    test_user: User,
):
    test_user.git_info = [
        {
            "id": "git-account-1",
            "git_domain": "https://Git.Example.com/",
            "git_token": "api-test-secret",
            "type": "gitea",
            "git_login": "alice",
            "git_email": "alice@example.com",
        }
    ]
    test_db.add(test_user)
    test_db.commit()

    response = git_credentials_client.get("/api/users/me/git-accounts/sync-summary")

    assert response.status_code == 200
    assert response.json() == {
        "accounts": [
            {
                "id": "git-account-1",
                "domain": "git.example.com",
                "provider": "gitea",
                "login": "alice",
                "email": "alice@example.com",
                "effective": True,
                "duplicate_of": None,
            }
        ],
        "effective_count": 1,
        "duplicate_count": 0,
    }
    assert "api-test-secret" not in response.text
    assert "git_token" not in response.text


@pytest.mark.api
def test_sync_endpoint_targets_one_device_and_returns_sanitized_result(
    git_credentials_client: TestClient,
    test_db: Session,
    test_user: User,
    mocker,
):
    sync = AsyncMock(
        return_value={
            "device_id": "remote-1",
            "status": "synced",
            "synced_domains": ["git.example.com"],
            "removed_domains": [],
            "duplicate_domains": [],
            "identity_warning_domains": [],
            "cli": [],
            "warning_codes": [],
        }
    )
    mocker.patch(
        "app.api.endpoints.devices.sync_git_accounts_to_device",
        sync,
    )

    response = git_credentials_client.put(
        "/api/devices/remote-1/git-accounts",
        json={"allow_empty": False},
    )

    assert response.status_code == 200
    assert response.json()["device_id"] == "remote-1"
    sync.assert_awaited_once_with(
        test_db,
        user=test_user,
        device_id="remote-1",
        allow_empty=False,
    )
