# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for the internal API key lookup endpoint."""

import hashlib
from datetime import datetime, timedelta
from typing import Tuple

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.api_key import KEY_TYPE_PERSONAL, KEY_TYPE_SERVICE, APIKey
from app.models.user import User

LOOKUP_URL = "/api/internal/api-keys/lookup"


@pytest.fixture(autouse=True)
def configure_internal_service_token(monkeypatch):
    monkeypatch.setattr(settings, "INTERNAL_SERVICE_TOKEN", "test-internal-token")


def _internal_headers() -> dict:
    return {"Authorization": f"Bearer {settings.INTERNAL_SERVICE_TOKEN}"}


class TestApiKeyLookupAuth:
    """The endpoint is gated by the internal service token, not user auth."""

    def test_missing_internal_token_is_rejected(self, test_client: TestClient):
        response = test_client.post(LOOKUP_URL, json={"api_key": "wg-anything"})
        assert response.status_code == 401

    def test_invalid_internal_token_is_rejected(self, test_client: TestClient):
        response = test_client.post(
            LOOKUP_URL,
            json={"api_key": "wg-anything"},
            headers={"Authorization": "Bearer wrong-token"},
        )
        assert response.status_code == 401


class TestApiKeyLookup:
    """Lookup behavior for existing / missing / invalid keys."""

    def test_valid_personal_key_returns_owner(
        self,
        test_client: TestClient,
        test_api_key: Tuple[str, APIKey],
        test_user: User,
    ):
        raw_key, _ = test_api_key

        response = test_client.post(
            LOOKUP_URL, json={"api_key": raw_key}, headers=_internal_headers()
        )

        assert response.status_code == 200
        assert response.json() == {"exists": True, "user_name": test_user.user_name}

    def test_unknown_key_reports_not_exists(self, test_client: TestClient):
        response = test_client.post(
            LOOKUP_URL,
            json={"api_key": "wg-does-not-exist"},
            headers=_internal_headers(),
        )

        assert response.status_code == 200
        assert response.json() == {"exists": False, "user_name": None}

    def test_non_wg_key_reports_not_exists(self, test_client: TestClient):
        response = test_client.post(
            LOOKUP_URL,
            json={"api_key": "not-an-api-key"},
            headers=_internal_headers(),
        )

        assert response.status_code == 200
        assert response.json() == {"exists": False, "user_name": None}

    def test_expired_key_reports_not_exists(
        self, test_client: TestClient, test_db: Session, test_user: User
    ):
        raw_key = "wg-expired-key-for-test"
        key_hash = hashlib.sha256(raw_key.encode()).hexdigest()
        test_db.add(
            APIKey(
                user_id=test_user.id,
                key_hash=key_hash,
                key_prefix="wg-expired...",
                name="Expired Key",
                key_type=KEY_TYPE_PERSONAL,
                expires_at=datetime.utcnow() - timedelta(days=1),
                is_active=True,
            )
        )
        test_db.commit()

        response = test_client.post(
            LOOKUP_URL, json={"api_key": raw_key}, headers=_internal_headers()
        )

        assert response.status_code == 200
        assert response.json() == {"exists": False, "user_name": None}

    def test_inactive_key_reports_not_exists(
        self, test_client: TestClient, test_db: Session, test_user: User
    ):
        raw_key = "wg-inactive-key-for-test"
        key_hash = hashlib.sha256(raw_key.encode()).hexdigest()
        test_db.add(
            APIKey(
                user_id=test_user.id,
                key_hash=key_hash,
                key_prefix="wg-inactive...",
                name="Inactive Key",
                key_type=KEY_TYPE_PERSONAL,
                expires_at=datetime.utcnow() + timedelta(days=365),
                is_active=False,
            )
        )
        test_db.commit()

        response = test_client.post(
            LOOKUP_URL, json={"api_key": raw_key}, headers=_internal_headers()
        )

        assert response.status_code == 200
        assert response.json() == {"exists": False, "user_name": None}

    def test_service_key_reports_not_exists(
        self, test_client: TestClient, test_db: Session, test_user: User
    ):
        """Only personal keys are looked up, matching verify_api_key's rules."""
        raw_key = "wg-service-key-for-test"
        key_hash = hashlib.sha256(raw_key.encode()).hexdigest()
        test_db.add(
            APIKey(
                user_id=test_user.id,
                key_hash=key_hash,
                key_prefix="wg-service...",
                name="Service Key",
                key_type=KEY_TYPE_SERVICE,
                expires_at=datetime.utcnow() + timedelta(days=365),
                is_active=True,
            )
        )
        test_db.commit()

        response = test_client.post(
            LOOKUP_URL, json={"api_key": raw_key}, headers=_internal_headers()
        )

        assert response.status_code == 200
        assert response.json() == {"exists": False, "user_name": None}

    def test_lookup_does_not_bump_last_used_at(
        self,
        test_client: TestClient,
        test_db: Session,
        test_api_key: Tuple[str, APIKey],
    ):
        raw_key, api_key_record = test_api_key
        original_last_used_at = api_key_record.last_used_at

        response = test_client.post(
            LOOKUP_URL, json={"api_key": raw_key}, headers=_internal_headers()
        )

        assert response.status_code == 200
        test_db.refresh(api_key_record)
        assert api_key_record.last_used_at == original_last_used_at
