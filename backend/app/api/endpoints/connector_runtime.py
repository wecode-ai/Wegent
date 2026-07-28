# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Minimal-scope connector runtime API consumed by executor MCP proxies."""

from fastapi import APIRouter, Depends, Header, HTTPException, status
from jose import JWTError, jwt
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core.config import settings
from app.core.security import create_access_token, get_current_user
from app.models.user import User
from app.schemas.connector import (
    ConnectorTokenResponse,
    ConnectorToolCallRequest,
    ConnectorToolCallResponse,
    ConnectorToolListResponse,
)
from app.services.connector_runtime import connector_runtime_service

router = APIRouter()
CONNECTOR_TOKEN_MINUTES = 15


def get_connector_runtime_user(
    authorization: str = Header(default=""), db: Session = Depends(get_db)
) -> User:
    if not authorization.startswith("Bearer "):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Connector token required")
    try:
        claims = jwt.decode(
            authorization.removeprefix("Bearer ").strip(),
            settings.SECRET_KEY,
            algorithms=[settings.ALGORITHM],
            audience="wegent-connector-runtime",
        )
    except JWTError as exc:
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED, "Invalid connector token"
        ) from exc
    if (
        claims.get("token_type") != "connector"
        or claims.get("aud") != "wegent-connector-runtime"
        or claims.get("scope") != "connectors:invoke"
    ):
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED, "Invalid connector token scope"
        )
    user_id = claims.get("user_id")
    if not isinstance(user_id, int):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid connector user")
    user = (
        db.query(User)
        .filter(User.id == user_id, User.user_name == claims.get("sub"))
        .first()
    )
    if not user or not user.is_active:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Connector user unavailable")
    return user


@router.post("/token", response_model=ConnectorTokenResponse)
def issue_connector_token(
    user: User = Depends(get_current_user),
) -> ConnectorTokenResponse:
    token = create_access_token(
        {
            "sub": user.user_name,
            "user_id": user.id,
            "token_type": "connector",
            "aud": "wegent-connector-runtime",
            "scope": "connectors:invoke",
        },
        expires_delta=CONNECTOR_TOKEN_MINUTES,
    )
    return ConnectorTokenResponse(
        access_token=token, expires_in=CONNECTOR_TOKEN_MINUTES * 60
    )


@router.get("/tools", response_model=ConnectorToolListResponse)
async def list_connector_tools(
    db: Session = Depends(get_db), user: User = Depends(get_connector_runtime_user)
) -> ConnectorToolListResponse:
    return ConnectorToolListResponse(
        tools=await connector_runtime_service.list_tools(db, user)
    )


@router.post("/call", response_model=ConnectorToolCallResponse)
async def call_connector_tool(
    payload: ConnectorToolCallRequest,
    db: Session = Depends(get_db),
    user: User = Depends(get_connector_runtime_user),
) -> ConnectorToolCallResponse:
    content, structured_content, is_error = await connector_runtime_service.call_tool(
        db, user, payload.name, payload.arguments
    )
    return ConnectorToolCallResponse(
        content=content,
        structured_content=structured_content,
        is_error=is_error,
    )
