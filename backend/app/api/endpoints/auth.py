# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from fastapi import APIRouter, Body, Depends, HTTPException
from fastapi.security import OAuth2PasswordRequestForm
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core.security import authenticate_user, create_access_token
from app.schemas.user import LoginRequest, LoginResponse, Token

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

    access_token = create_access_token(data={"sub": user.user_name})
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

    access_token = create_access_token(data={"sub": user.user_name})

    return LoginResponse(access_token=access_token, token_type="bearer")
