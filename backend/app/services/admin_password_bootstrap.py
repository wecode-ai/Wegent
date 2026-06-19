# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Bootstrap flow for the initial administrator password."""

import secrets
from typing import NoReturn

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.exceptions import CustomHTTPException
from app.core.security import get_password_hash
from app.models.system_config import SystemConfig
from app.models.user import User
from shared.telemetry.decorators import add_span_event, set_span_attribute, trace_sync

ADMIN_PASSWORD_SETUP_CONFIG_KEY = "admin_password_initialized"
ADMIN_PASSWORD_SETUP_REQUIRED_ERROR_CODE = "ADMIN_PASSWORD_SETUP_REQUIRED"
INITIAL_ADMIN_USERNAME = "admin"
_admin_password_setup_required_cache = False
_admin_password_setup_state_loaded = False


def _read_admin_password_setup_required(db: Session) -> bool:
    config = (
        db.query(SystemConfig)
        .filter(SystemConfig.config_key == ADMIN_PASSWORD_SETUP_CONFIG_KEY)
        .first()
    )
    return bool(config and config.config_value.get("completed") is False)


def load_admin_password_setup_state(db: Session) -> bool:
    """Load first-run admin password setup state into process memory."""
    if not settings.CHECK_SYSTEM_INITIALIZATION_STATUS:
        set_admin_password_setup_required_cache(False)
        return False

    required = _read_admin_password_setup_required(db)
    set_admin_password_setup_required_cache(required)
    return required


def set_admin_password_setup_required_cache(required: bool) -> None:
    """Update the in-memory first-run admin password setup state."""
    global _admin_password_setup_required_cache, _admin_password_setup_state_loaded
    _admin_password_setup_required_cache = required
    _admin_password_setup_state_loaded = True
    set_span_attribute("auth.bootstrap.setup_required_cache", required)


def reset_admin_password_setup_state_cache() -> None:
    """Reset cached state for tests and controlled reinitialization."""
    global _admin_password_setup_required_cache, _admin_password_setup_state_loaded
    _admin_password_setup_required_cache = False
    _admin_password_setup_state_loaded = False


def get_cached_admin_password_setup_required() -> bool:
    """Return the cached first-run admin password setup state."""
    if not settings.CHECK_SYSTEM_INITIALIZATION_STATUS:
        return False
    return _admin_password_setup_state_loaded and _admin_password_setup_required_cache


def raise_admin_password_setup_required() -> NoReturn:
    """Raise the structured API error used by the frontend bootstrap handshake."""
    raise CustomHTTPException(
        status_code=status.HTTP_400_BAD_REQUEST,
        detail={
            "error_code": ADMIN_PASSWORD_SETUP_REQUIRED_ERROR_CODE,
            "admin_username": INITIAL_ADMIN_USERNAME,
        },
        error_code=ADMIN_PASSWORD_SETUP_REQUIRED_ERROR_CODE,
    )


@trace_sync("auth.bootstrap.create_unusable_password_hash", "backend.auth")
def create_unusable_password_hash() -> str:
    """Create a password hash for a random value that is never persisted."""
    add_span_event("admin_password.unusable_hash_created")
    return get_password_hash(secrets.token_urlsafe(48))


@trace_sync("auth.bootstrap.mark_setup_required", "backend.auth")
def mark_admin_password_setup_required(db: Session, *, admin_user_id: int) -> None:
    """Mark a newly bootstrapped admin as requiring first password setup."""
    set_span_attribute("auth.bootstrap.admin_user_id", admin_user_id)
    add_span_event("admin_password.setup_required_marked")
    config = SystemConfig(
        config_key=ADMIN_PASSWORD_SETUP_CONFIG_KEY,
        updated_by=admin_user_id,
    )
    config.config_value = {"completed": False}
    db.add(config)
    set_admin_password_setup_required_cache(True)


@trace_sync("auth.bootstrap.setup_initial_admin_password", "backend.auth")
def setup_initial_admin_password(db: Session, *, password: str) -> User:
    """Set the initial admin password if the bootstrap window is still open."""
    add_span_event("admin_password.initial_setup_requested")
    config = (
        db.query(SystemConfig)
        .filter(SystemConfig.config_key == ADMIN_PASSWORD_SETUP_CONFIG_KEY)
        .with_for_update()
        .first()
    )
    if not config or config.config_value.get("completed") is not False:
        set_span_attribute("auth.bootstrap.setup_allowed", False)
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Admin password already initialized",
        )

    admin_user = (
        db.query(User)
        .filter(User.user_name == INITIAL_ADMIN_USERNAME)
        .with_for_update()
        .first()
    )
    if not admin_user:
        set_span_attribute("auth.bootstrap.setup_allowed", False)
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Initial admin user is not available",
        )

    admin_user.password_hash = get_password_hash(password)
    admin_user.auth_source = "password"
    config.config_value = {"completed": True}
    config.updated_by = admin_user.id
    config.version += 1
    db.commit()
    db.refresh(admin_user)
    set_admin_password_setup_required_cache(False)
    set_span_attribute("auth.bootstrap.setup_allowed", True)
    set_span_attribute("auth.bootstrap.admin_user_id", admin_user.id)
    add_span_event("admin_password.initial_setup_completed")
    return admin_user
