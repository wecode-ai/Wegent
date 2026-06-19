# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Bootstrap flow for the initial administrator password."""

import secrets

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.core.security import get_password_hash
from app.models.system_config import SystemConfig
from app.models.user import User
from shared.telemetry.decorators import add_span_event, set_span_attribute, trace_sync

ADMIN_PASSWORD_SETUP_CONFIG_KEY = "admin_password_initialized"
ADMIN_PASSWORD_SETUP_REQUIRED_ERROR_CODE = "ADMIN_PASSWORD_SETUP_REQUIRED"
INITIAL_ADMIN_USERNAME = "admin"


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


@trace_sync("auth.bootstrap.is_setup_required", "backend.auth")
def is_admin_password_setup_required(db: Session) -> bool:
    """Return whether the public one-time admin password setup is open."""
    config = (
        db.query(SystemConfig)
        .filter(SystemConfig.config_key == ADMIN_PASSWORD_SETUP_CONFIG_KEY)
        .first()
    )
    required = bool(config and config.config_value.get("completed") is False)
    set_span_attribute("auth.bootstrap.setup_required", required)
    return required


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
    set_span_attribute("auth.bootstrap.setup_allowed", True)
    set_span_attribute("auth.bootstrap.admin_user_id", admin_user.id)
    add_span_event("admin_password.initial_setup_completed")
    return admin_user
