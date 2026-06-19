# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.core.security import authenticate_user, get_password_hash
from app.core.yaml_init import ensure_default_user
from app.models.system_config import SystemConfig
from app.models.user import User

ADMIN_PASSWORD_SETUP_CONFIG_KEY = "admin_password_initialized"


def _get_admin_password_config(db: Session) -> SystemConfig | None:
    return (
        db.query(SystemConfig)
        .filter(SystemConfig.config_key == ADMIN_PASSWORD_SETUP_CONFIG_KEY)
        .first()
    )


def test_new_bootstrap_admin_cannot_login_with_default_password(
    test_client: TestClient,
    test_db: Session,
):
    user_id, is_new = ensure_default_user(test_db)

    assert is_new is True
    config = _get_admin_password_config(test_db)
    assert config is not None
    assert config.updated_by == user_id
    assert config.config_value == {"completed": False}
    assert authenticate_user(test_db, "admin", "Wegent2025!") is None

    response = test_client.post(
        "/api/auth/login",
        json={"user_name": "admin", "password": "Wegent2025!"},
    )

    assert response.status_code == 400
    assert response.json()["error_code"] == "ADMIN_PASSWORD_SETUP_REQUIRED"
    assert response.json()["detail"] == {
        "error_code": "ADMIN_PASSWORD_SETUP_REQUIRED",
        "admin_username": "admin",
    }


def test_bootstrap_admin_password_setup_succeeds_once(
    test_client: TestClient,
    test_db: Session,
):
    ensure_default_user(test_db)

    status_response = test_client.get("/api/auth/admin-password/status")

    assert status_response.status_code == 200
    assert status_response.json() == {"required": True, "admin_username": "admin"}

    setup_response = test_client.post(
        "/api/auth/admin-password/setup",
        json={"password": "secure-admin-password"},
    )

    assert setup_response.status_code == 200
    assert setup_response.json()["token_type"] == "bearer"
    assert setup_response.json()["access_token"]
    assert authenticate_user(test_db, "admin", "secure-admin-password") is not None
    assert authenticate_user(test_db, "admin", "Wegent2025!") is None
    assert _get_admin_password_config(test_db).config_value == {"completed": True}

    second_setup_response = test_client.post(
        "/api/auth/admin-password/setup",
        json={"password": "another-password"},
    )

    assert second_setup_response.status_code == 409
    assert (
        second_setup_response.json()["detail"] == "Admin password already initialized"
    )


def test_existing_admin_without_bootstrap_marker_is_not_publicly_resettable(
    test_client: TestClient,
    test_db: Session,
):
    admin = User(
        user_name="admin",
        password_hash=get_password_hash("existing-admin-password"),
        email="admin@example.com",
        is_active=True,
        role="admin",
        auth_source="password",
    )
    test_db.add(admin)
    test_db.commit()

    status_response = test_client.get("/api/auth/admin-password/status")

    assert status_response.status_code == 200
    assert status_response.json() == {"required": False, "admin_username": "admin"}

    setup_response = test_client.post(
        "/api/auth/admin-password/setup",
        json={"password": "public-reset-attempt"},
    )

    assert setup_response.status_code == 409
    assert setup_response.json()["detail"] == "Admin password already initialized"
    assert authenticate_user(test_db, "admin", "existing-admin-password") is not None
