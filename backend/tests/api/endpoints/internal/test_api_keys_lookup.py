# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for the internal API key lookup endpoint."""

import hashlib
from datetime import datetime, timedelta
from typing import Tuple

import pytest
from fastapi.testclient import TestClient
from pytest_mock import MockerFixture
from sqlalchemy.orm import Session

from app.api.endpoints.internal import api_keys as api_keys_endpoint
from app.core.config import settings
from app.models.api_key import (
    KEY_TYPE_PERSONAL,
    KEY_TYPE_PLUGIN_RELEASE,
    KEY_TYPE_SERVICE,
    APIKey,
)
from app.models.user import User

LOOKUP_URL = "/api/internal/api-keys/lookup"


@pytest.fixture(autouse=True)
def configure_internal_service_token(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "INTERNAL_SERVICE_TOKEN", "test-internal-token")


def _internal_headers() -> dict[str, str]:
    return {"Authorization": f"Bearer {settings.INTERNAL_SERVICE_TOKEN}"}


class TestApiKeyLookupAuth:
    """The endpoint is gated by the internal service token, not user auth."""

    def test_missing_internal_token_is_rejected(self, test_client: TestClient) -> None:
        response = test_client.post(LOOKUP_URL, json={"api_key": "wg-anything"})
        assert response.status_code == 401

    def test_invalid_internal_token_is_rejected(self, test_client: TestClient) -> None:
        response = test_client.post(
            LOOKUP_URL,
            json={"api_key": "wg-anything"},
            headers={"Authorization": "Bearer wrong-token"},
        )
        assert response.status_code == 401

    def test_unconfigured_internal_token_is_rejected(
        self, test_client: TestClient, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        headers = _internal_headers()
        monkeypatch.setattr(settings, "INTERNAL_SERVICE_TOKEN", "")

        response = test_client.post(
            LOOKUP_URL, json={"api_key": "wg-anything"}, headers=headers
        )

        assert response.status_code == 401


class TestApiKeyLookup:
    """Lookup behavior for existing / missing / invalid keys."""

    def test_valid_personal_key_returns_owner(
        self,
        test_client: TestClient,
        test_db: Session,
        test_api_key: Tuple[str, APIKey],
        test_admin_api_key: Tuple[str, APIKey],
        test_user: User,
    ) -> None:
        raw_key, _ = test_api_key
        _, unrelated_service_key = test_admin_api_key
        unrelated_service_key.key_type = KEY_TYPE_SERVICE
        test_db.commit()

        response = test_client.post(
            LOOKUP_URL, json={"api_key": raw_key}, headers=_internal_headers()
        )

        assert response.status_code == 200
        assert response.json() == {
            "exists": True,
            "user_name": test_user.user_name,
            "key_type": KEY_TYPE_PERSONAL,
        }

    def test_unknown_key_reports_not_exists(self, test_client: TestClient) -> None:
        response = test_client.post(
            LOOKUP_URL,
            json={"api_key": "wg-does-not-exist"},
            headers=_internal_headers(),
        )

        assert response.status_code == 200
        assert response.json() == {
            "exists": False,
            "user_name": None,
            "key_type": None,
        }

    @pytest.mark.parametrize("key_type", [KEY_TYPE_SERVICE, KEY_TYPE_PERSONAL])
    def test_non_wg_key_reports_not_exists(
        self,
        test_client: TestClient,
        test_db: Session,
        test_api_key: Tuple[str, APIKey],
        key_type: str,
    ) -> None:
        raw_key = "not-an-api-key"
        _, api_key_record = test_api_key
        api_key_record.key_hash = hashlib.sha256(raw_key.encode()).hexdigest()
        api_key_record.key_type = key_type
        test_db.commit()

        response = test_client.post(
            LOOKUP_URL,
            json={"api_key": raw_key},
            headers=_internal_headers(),
        )

        assert response.status_code == 200
        assert response.json() == {
            "exists": False,
            "user_name": None,
            "key_type": None,
        }

    @pytest.mark.parametrize("key_type", [KEY_TYPE_SERVICE, KEY_TYPE_PERSONAL])
    def test_expired_key_reports_not_exists(
        self,
        test_client: TestClient,
        test_db: Session,
        test_api_key: Tuple[str, APIKey],
        key_type: str,
    ) -> None:
        raw_key, api_key_record = test_api_key
        api_key_record.key_type = key_type
        api_key_record.expires_at = datetime.utcnow() - timedelta(days=1)
        test_db.commit()

        response = test_client.post(
            LOOKUP_URL, json={"api_key": raw_key}, headers=_internal_headers()
        )

        assert response.status_code == 200
        assert response.json() == {
            "exists": False,
            "user_name": None,
            "key_type": None,
        }

    @pytest.mark.parametrize("key_type", [KEY_TYPE_SERVICE, KEY_TYPE_PERSONAL])
    def test_inactive_key_reports_not_exists(
        self,
        test_client: TestClient,
        test_db: Session,
        test_api_key: Tuple[str, APIKey],
        key_type: str,
    ) -> None:
        raw_key, api_key_record = test_api_key
        api_key_record.key_type = key_type
        api_key_record.is_active = False
        test_db.commit()

        response = test_client.post(
            LOOKUP_URL, json={"api_key": raw_key}, headers=_internal_headers()
        )

        assert response.status_code == 200
        assert response.json() == {
            "exists": False,
            "user_name": None,
            "key_type": None,
        }

    def test_admin_created_service_key_returns_its_name_before_personal_lookup(
        self,
        test_client: TestClient,
        test_admin_token: str,
        test_admin_user: User,
        mocker: MockerFixture,
    ) -> None:
        service_name = "model-proxy-service"
        created = test_client.post(
            "/api/admin/service-keys",
            json={"name": service_name},
            headers={"Authorization": f"Bearer {test_admin_token}"},
        )
        assert created.status_code == 201
        assert created.json()["created_by"] == test_admin_user.user_name
        personal_lookup = mocker.spy(api_keys_endpoint, "verify_api_key")

        response = test_client.post(
            LOOKUP_URL,
            json={"api_key": created.json()["key"]},
            headers=_internal_headers(),
        )

        assert response.status_code == 200
        assert response.json() == {
            "exists": True,
            "user_name": service_name,
            "key_type": KEY_TYPE_SERVICE,
        }
        personal_lookup.assert_not_called()

    @pytest.mark.parametrize("key_type", [KEY_TYPE_SERVICE, KEY_TYPE_PERSONAL])
    def test_lookup_does_not_bump_last_used_at(
        self,
        test_client: TestClient,
        test_db: Session,
        test_api_key: Tuple[str, APIKey],
        mocker: MockerFixture,
        key_type: str,
    ) -> None:
        raw_key, api_key_record = test_api_key
        original_last_used_at = datetime(2026, 1, 1, 8, 0, 0)
        api_key_record.key_type = key_type
        api_key_record.last_used_at = original_last_used_at
        test_db.commit()
        commit = mocker.spy(test_db, "commit")

        response = test_client.post(
            LOOKUP_URL, json={"api_key": raw_key}, headers=_internal_headers()
        )

        assert response.status_code == 200
        assert response.json()["exists"] is True
        test_db.refresh(api_key_record)
        assert api_key_record.last_used_at == original_last_used_at
        commit.assert_not_called()

    @pytest.mark.parametrize("key_type", [KEY_TYPE_SERVICE, KEY_TYPE_PERSONAL])
    def test_lookup_with_inactive_owner(
        self,
        test_client: TestClient,
        test_db: Session,
        test_api_key: Tuple[str, APIKey],
        test_user: User,
        key_type: str,
    ) -> None:
        raw_key, api_key_record = test_api_key
        api_key_record.key_type = key_type
        test_user.is_active = False
        test_db.commit()

        response = test_client.post(
            LOOKUP_URL, json={"api_key": raw_key}, headers=_internal_headers()
        )

        assert response.status_code == 200
        assert response.json() == (
            {"exists": True, "user_name": api_key_record.name, "key_type": key_type}
            if key_type == KEY_TYPE_SERVICE
            else {"exists": False, "user_name": None, "key_type": None}
        )

    def test_personal_key_with_missing_owner_reports_not_exists(
        self,
        test_client: TestClient,
        test_db: Session,
        test_api_key: Tuple[str, APIKey],
    ) -> None:
        raw_key, api_key_record = test_api_key
        api_key_record.user_id = 999999
        test_db.commit()

        response = test_client.post(
            LOOKUP_URL, json={"api_key": raw_key}, headers=_internal_headers()
        )

        assert response.status_code == 200
        assert response.json() == {
            "exists": False,
            "user_name": None,
            "key_type": None,
        }

    def test_plugin_release_key_reports_not_exists(
        self,
        test_client: TestClient,
        test_db: Session,
        test_api_key: Tuple[str, APIKey],
    ) -> None:
        raw_key, api_key_record = test_api_key
        api_key_record.key_type = KEY_TYPE_PLUGIN_RELEASE
        test_db.commit()

        response = test_client.post(
            LOOKUP_URL, json={"api_key": raw_key}, headers=_internal_headers()
        )

        assert response.status_code == 200
        assert response.json() == {
            "exists": False,
            "user_name": None,
            "key_type": None,
        }

    @pytest.mark.parametrize("body", [{}, {"api_key": ""}, {"api_key": None}])
    def test_invalid_request_is_rejected(
        self, test_client: TestClient, body: dict[str, object]
    ) -> None:
        response = test_client.post(LOOKUP_URL, json=body, headers=_internal_headers())

        assert response.status_code == 422
