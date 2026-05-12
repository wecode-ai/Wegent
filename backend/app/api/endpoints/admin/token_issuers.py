# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Admin endpoints for outbound token signing keys and issuers."""

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core.exceptions import CustomHTTPException
from app.core.security import get_admin_user
from app.models.user import User
from app.schemas.token_issuer import (
    SigningKeyCreateRequest,
    SigningKeyListResponse,
    SigningKeyResponse,
    TokenIssuerCreateRequest,
    TokenIssuerListResponse,
    TokenIssuerResponse,
    TokenIssuerUpdateRequest,
)
from app.services.auth.outbound_token_service import (
    OutboundTokenValidationError,
    SigningKeyNotFoundError,
    TokenIssuerNotFoundError,
    outbound_token_service,
)

router = APIRouter()


def _raise_http_error(exc: Exception) -> None:
    if isinstance(exc, (SigningKeyNotFoundError, TokenIssuerNotFoundError)):
        raise CustomHTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=str(exc),
            error_code=getattr(exc, "error_code", None),
        )
    if isinstance(exc, OutboundTokenValidationError):
        raise CustomHTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(exc),
            error_code=getattr(exc, "error_code", None),
        )
    raise exc


@router.get("/signing-keys", response_model=SigningKeyListResponse)
async def list_signing_keys(
    db: Session = Depends(get_db),
    _: User = Depends(get_admin_user),
):
    items = outbound_token_service.list_signing_keys(db)
    return SigningKeyListResponse(items=items, total=len(items))


@router.post(
    "/signing-keys",
    response_model=SigningKeyResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_signing_key(
    request: SigningKeyCreateRequest,
    db: Session = Depends(get_db),
    _: User = Depends(get_admin_user),
):
    try:
        return outbound_token_service.create_signing_key(db, request)
    except Exception as exc:
        _raise_http_error(exc)


@router.post("/signing-keys/{key_id}/toggle-status", response_model=SigningKeyResponse)
async def toggle_signing_key_status(
    key_id: int,
    db: Session = Depends(get_db),
    _: User = Depends(get_admin_user),
):
    try:
        return outbound_token_service.toggle_signing_key_status(db, key_id)
    except Exception as exc:
        _raise_http_error(exc)


@router.delete("/signing-keys/{key_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_signing_key(
    key_id: int,
    db: Session = Depends(get_db),
    _: User = Depends(get_admin_user),
):
    try:
        outbound_token_service.delete_signing_key(db, key_id)
    except Exception as exc:
        _raise_http_error(exc)
    return None


@router.get("/token-issuers", response_model=TokenIssuerListResponse)
async def list_token_issuers(
    db: Session = Depends(get_db),
    _: User = Depends(get_admin_user),
):
    items = outbound_token_service.list_token_issuers(db)
    return TokenIssuerListResponse(items=items, total=len(items))


@router.post(
    "/token-issuers",
    response_model=TokenIssuerResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_token_issuer(
    request: TokenIssuerCreateRequest,
    db: Session = Depends(get_db),
    _: User = Depends(get_admin_user),
):
    try:
        return outbound_token_service.create_token_issuer(db, request)
    except Exception as exc:
        _raise_http_error(exc)


@router.put("/token-issuers/{issuer_id}", response_model=TokenIssuerResponse)
async def update_token_issuer(
    issuer_id: int,
    request: TokenIssuerUpdateRequest,
    db: Session = Depends(get_db),
    _: User = Depends(get_admin_user),
):
    try:
        return outbound_token_service.update_token_issuer(db, issuer_id, request)
    except Exception as exc:
        _raise_http_error(exc)


@router.post(
    "/token-issuers/{issuer_id}/toggle-status", response_model=TokenIssuerResponse
)
async def toggle_token_issuer_status(
    issuer_id: int,
    db: Session = Depends(get_db),
    _: User = Depends(get_admin_user),
):
    try:
        return outbound_token_service.toggle_token_issuer_status(db, issuer_id)
    except Exception as exc:
        _raise_http_error(exc)


@router.delete("/token-issuers/{issuer_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_token_issuer(
    issuer_id: int,
    db: Session = Depends(get_db),
    _: User = Depends(get_admin_user),
):
    try:
        outbound_token_service.delete_token_issuer(db, issuer_id)
    except Exception as exc:
        _raise_http_error(exc)
    return None
