# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from fastapi import APIRouter, Body, Depends, HTTPException
from fastapi.security import OAuth2PasswordRequestForm
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core.security import authenticate_user, create_access_token
from app.schemas.user import (
    AdminPasswordSetupRequest,
    AdminPasswordSetupStatusResponse,
    LoginRequest,
    LoginResponse,
    Token,
)
from app.services.admin_password_bootstrap import (
    INITIAL_ADMIN_USERNAME,
    is_admin_password_setup_required,
    setup_initial_admin_password,
)
from shared.telemetry.decorators import add_span_event, set_span_attribute, trace_sync

router = APIRouter()


@router.post("/oauth2", response_model=Token, include_in_schema=False)
def login_swagger(
    db: Session = Depends(get_db), form_data: OAuth2PasswordRequestForm = Depends()
) -> LoginResponse:
    """
    Swagger-style login interface (form format)
    Returns JWT token
    """
    user = authenticate_user(db, form_data.username, form_data.password)
    if not user:
        raise HTTPException(status_code=400, detail="Invalid username or password")

    # Update auth_source if it was unknown
    if user.auth_source == "unknown":
        user.auth_source = "password"
        db.commit()

    access_token = create_access_token(data={"sub": user.user_name, "user_id": user.id})
    return {"access_token": access_token, "token_type": "bearer"}


@router.post("/login", response_model=Token)
def login(db: Session = Depends(get_db), login_data: LoginRequest = Body(...)):
    """
    JSON format login interface
    Returns JWT token
    """
    user = authenticate_user(db, login_data.user_name, login_data.password)
    if not user:
        raise HTTPException(status_code=400, detail="Invalid username or password")

    # Update auth_source if it was unknown
    if user.auth_source == "unknown":
        user.auth_source = "password"
        db.commit()

    access_token = create_access_token(data={"sub": user.user_name, "user_id": user.id})

    return LoginResponse(access_token=access_token, token_type="bearer")


@router.get(
    "/admin-password/status",
    response_model=AdminPasswordSetupStatusResponse,
)
@trace_sync("auth.admin_password_setup_status", "backend.auth")
def get_admin_password_setup_status(
    db: Session = Depends(get_db),
) -> AdminPasswordSetupStatusResponse:
    """Return whether first-run admin password setup is required."""
    add_span_event("admin_password_setup_status_checked")
    set_span_attribute("auth.bootstrap.status_check", True)
    return AdminPasswordSetupStatusResponse(
        required=is_admin_password_setup_required(db),
        admin_username=INITIAL_ADMIN_USERNAME,
    )


@router.post("/admin-password/setup", response_model=LoginResponse)
@trace_sync("auth.admin_password_setup", "backend.auth")
def setup_admin_password(
    setup_data: AdminPasswordSetupRequest,
    db: Session = Depends(get_db),
) -> LoginResponse:
    """Set the initial admin password and return a login token."""
    add_span_event("admin_password_setup_requested")
    user = setup_initial_admin_password(db, password=setup_data.password)
    set_span_attribute("auth.bootstrap.user_id", user.id)
    access_token = create_access_token(data={"sub": user.user_name, "user_id": user.id})
    return LoginResponse(access_token=access_token, token_type="bearer")
