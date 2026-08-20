# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Administrative OAuth client management."""

from fastapi import APIRouter, Depends, Response, status
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core.exceptions import CustomHTTPException
from app.core.security import get_admin_user
from app.models.user import User
from app.schemas.oauth_provider import (
    OAuthClientCreateRequest,
    OAuthClientListResponse,
    OAuthClientResponse,
    OAuthClientUpdateRequest,
)
from app.services.auth.oauth_provider import (
    OAuthProviderError,
    oauth_provider_service,
)

router = APIRouter(prefix="/oauth-clients")


def _raise_error(exc: OAuthProviderError) -> None:
    raise CustomHTTPException(
        status_code=exc.status_code,
        detail=exc.description,
        error_code=exc.error,
    )


@router.get("", response_model=OAuthClientListResponse)
async def list_oauth_clients(
    db: Session = Depends(get_db),
    _: User = Depends(get_admin_user),
) -> OAuthClientListResponse:
    items = oauth_provider_service.list_clients(db)
    return OAuthClientListResponse(items=items, total=len(items))


@router.post(
    "",
    response_model=OAuthClientResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_oauth_client(
    request: OAuthClientCreateRequest,
    db: Session = Depends(get_db),
    _: User = Depends(get_admin_user),
) -> OAuthClientResponse:
    try:
        return oauth_provider_service.create_client(db, request)
    except OAuthProviderError as exc:
        _raise_error(exc)


@router.put("/{client_kind_id}", response_model=OAuthClientResponse)
async def update_oauth_client(
    client_kind_id: int,
    request: OAuthClientUpdateRequest,
    db: Session = Depends(get_db),
    _: User = Depends(get_admin_user),
) -> OAuthClientResponse:
    try:
        return oauth_provider_service.update_client(db, client_kind_id, request)
    except OAuthProviderError as exc:
        _raise_error(exc)


@router.post(
    "/{client_kind_id}/rotate-secret",
    response_model=OAuthClientResponse,
)
async def rotate_oauth_client_secret(
    client_kind_id: int,
    db: Session = Depends(get_db),
    _: User = Depends(get_admin_user),
) -> OAuthClientResponse:
    try:
        return oauth_provider_service.rotate_client_secret(db, client_kind_id)
    except OAuthProviderError as exc:
        _raise_error(exc)


@router.delete("/{client_kind_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_oauth_client(
    client_kind_id: int,
    db: Session = Depends(get_db),
    _: User = Depends(get_admin_user),
) -> Response:
    try:
        oauth_provider_service.delete_client(db, client_kind_id)
    except OAuthProviderError as exc:
        _raise_error(exc)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
