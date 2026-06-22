# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.security import authenticate_user, get_password_hash
from app.core.yaml_init import ensure_default_user
from app.models.system_config import SystemConfig
from app.models.user import User
from app.services.admin_password_bootstrap import (
    get_cached_admin_password_setup_required,
    load_admin_password_setup_state,
    reset_admin_password_setup_state_cache,
)

ADMIN_PASSWORD_SETUP_CONFIG_KEY = "admin_password_initialized"


def _get_admin_password_config(db: Session) -> SystemConfig | None:
    return (
        db.query(SystemConfig)
        .filter(SystemConfig.config_key == ADMIN_PASSWORD_SETUP_CONFIG_KEY)
        .first()
    )


def test_current_user_handshake_returns_setup_required_from_startup_cache(
    test_client: TestClient,
    test_db: Session,
):
    ensure_default_user(test_db)
    load_admin_password_setup_state(test_db)

    config = _get_admin_password_config(test_db)
    config.config_value = {"completed": True}
    test_db.commit()

    response = test_client.get("/api/users/me")

    assert get_cached_admin_password_setup_required() is True
    assert response.status_code == 400
    assert response.json()["error_code"] == "ADMIN_PASSWORD_SETUP_REQUIRED"
    assert response.json()["detail"] == {
        "error_code": "ADMIN_PASSWORD_SETUP_REQUIRED",
        "admin_username": "admin",
    }


def test_current_user_handshake_skips_setup_status_when_check_disabled(
    monkeypatch,
    test_client: TestClient,
    test_db: Session,
):
    monkeypatch.setattr(settings, "CHECK_SYSTEM_INITIALIZATION_STATUS", False)
    ensure_default_user(test_db)
    load_admin_password_setup_state(test_db)

    response = test_client.get("/api/users/me")

    assert get_cached_admin_password_setup_required() is False
    assert response.status_code == 401
    assert response.json()["detail"] == "Missing authentication credentials"


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
    assert response.json()["detail"] == "Invalid username or password"


def test_bootstrap_admin_password_setup_succeeds_once(
    test_client: TestClient,
    test_db: Session,
):
    ensure_default_user(test_db)
    load_admin_password_setup_state(test_db)

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
    assert get_cached_admin_password_setup_required() is False

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
    load_admin_password_setup_state(test_db)

    setup_response = test_client.post(
        "/api/auth/admin-password/setup",
        json={"password": "public-reset-attempt"},
    )

    assert setup_response.status_code == 409
    assert setup_response.json()["detail"] == "Admin password already initialized"
    assert authenticate_user(test_db, "admin", "existing-admin-password") is not None


def teardown_function():
    settings.CHECK_SYSTEM_INITIALIZATION_STATUS = True
    reset_admin_password_setup_state_cache()
