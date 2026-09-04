# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""HTTP contract tests for plugin release keys."""

from datetime import datetime, timedelta, timezone

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.models.api_key import KEY_TYPE_PLUGIN_RELEASE, APIKey


def test_create_plugin_release_key_uses_minimal_contract(
    test_client: TestClient,
    test_db: Session,
    test_admin_token: str,
) -> None:
    response = test_client.post(
        "/api/admin/plugin-release-keys",
        headers={"Authorization": f"Bearer {test_admin_token}"},
        json={
            "name": "Protected master release",
            "description": "GitLab protected pipeline",
        },
    )

    assert response.status_code == 201
    payload = response.json()
    assert payload["key"].startswith("wg-")
    assert "scopes" not in payload
    assert "projectIds" not in payload
    assert "environments" not in payload

    record = (
        test_db.query(APIKey).filter(APIKey.key_type == KEY_TYPE_PLUGIN_RELEASE).one()
    )
    assert record.name == "Protected master release"
    assert record.expires_at.year == 9999
    assert not hasattr(record, "scopes_json")
    assert not hasattr(record, "restrictions_json")


def test_create_plugin_release_key_accepts_explicit_expiry(
    test_client: TestClient,
    test_db: Session,
    test_admin_token: str,
) -> None:
    expires_at = datetime.now(timezone.utc) + timedelta(days=1)

    response = test_client.post(
        "/api/admin/plugin-release-keys",
        headers={"Authorization": f"Bearer {test_admin_token}"},
        json={"name": "Temporary release", "expiresAt": expires_at.isoformat()},
    )

    assert response.status_code == 201
    record = (
        test_db.query(APIKey).filter(APIKey.key_type == KEY_TYPE_PLUGIN_RELEASE).one()
    )
    assert record.expires_at.year != 9999
