# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Public endpoints for the constrained external OAuth provider."""

import base64
from urllib.parse import unquote_plus

from fastapi import APIRouter, Depends, Form, Header, Query, Response
from fastapi.responses import JSONResponse, RedirectResponse
from fastapi.security.utils import get_authorization_scheme_param
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core import security
from app.core.config import settings
from app.models.user import User
from app.schemas.oauth_provider import (
    OAuthAuthorizationDecisionResponse,
    OAuthAuthorizationRequestResponse,
    OAuthJwks,
    OAuthProviderMetadata,
    OAuthTokenResponse,
    OAuthUserInfoResponse,
)
from app.services.auth.oauth_provider import (
    OAUTH_SCOPE,
    OAuthProviderError,
    oauth_provider_issuer,
    oauth_provider_service,
)

router = APIRouter(prefix="/external/oauth", tags=["oauth-provider"])
metadata_router = APIRouter(tags=["oauth-provider"])


def _oauth_error(exc: OAuthProviderError) -> JSONResponse:
    headers = {"Cache-Control": "no-store", "Pragma": "no-cache"}
    if exc.status_code == 401:
        if exc.error == "invalid_client":
            headers["WWW-Authenticate"] = 'Basic realm="oauth", error="invalid_client"'
        else:
            description = exc.description.replace("\\", "\\\\").replace('"', '\\"')
            headers["WWW-Authenticate"] = (
                f'Bearer realm="userinfo", error="{exc.error}", '
                f'error_description="{description}"'
            )
    return JSONResponse(
        status_code=exc.status_code,
        content={"error": exc.error, "error_description": exc.description},
        headers=headers,
    )


def _parse_client_credentials(
    authorization: str, form_client_id: str, form_client_secret: str | None
) -> tuple[str, str | None]:
    scheme, encoded = get_authorization_scheme_param(authorization)
    if not authorization:
        return form_client_id, form_client_secret
    if scheme.lower() != "basic":
        raise OAuthProviderError(
            "invalid_client", "Unsupported client authentication method", 401
        )
    if form_client_id or form_client_secret is not None:
        raise OAuthProviderError(
            "invalid_request", "Multiple client authentication methods are not allowed"
        )
    try:
        decoded = base64.b64decode(encoded, validate=True).decode("utf-8")
        basic_client_id, basic_secret = decoded.split(":", 1)
    except Exception as exc:
        raise OAuthProviderError(
            "invalid_client", "Malformed HTTP Basic client credentials", 401
        ) from exc
    return unquote_plus(basic_client_id), unquote_plus(basic_secret)


def _provider_base_url() -> str:
    return oauth_provider_issuer()


@metadata_router.get(
    f"/.well-known/oauth-authorization-server{settings.API_PREFIX.rstrip('/')}",
    response_model=OAuthProviderMetadata,
)
async def oauth_provider_metadata() -> OAuthProviderMetadata:
    base = _provider_base_url()
    return OAuthProviderMetadata(
        issuer=base,
        authorization_endpoint=f"{base}/external/oauth/authorize",
        token_endpoint=f"{base}/external/oauth/token",
        revocation_endpoint=f"{base}/external/oauth/revoke",
        jwks_uri=f"{base}/external/oauth/jwks",
        userinfo_endpoint=f"{base}/external/oauth/userinfo",
    )


@router.get("/jwks", response_model=OAuthJwks)
async def jwks(db: Session = Depends(get_db)) -> OAuthJwks:
    return oauth_provider_service.jwks(db)


@router.get("/authorize")
async def authorize(
    response_type: str = Query(..., max_length=32),
    client_id: str = Query(..., min_length=1, max_length=100),
    redirect_uri: str = Query(..., min_length=1, max_length=2048),
    scope: str = Query(default=OAUTH_SCOPE, max_length=100),
    state: str = Query(default="", max_length=2048),
    code_challenge: str = Query(..., min_length=43, max_length=128),
    code_challenge_method: str = Query(..., max_length=16),
    db: Session = Depends(get_db),
):
    try:
        redirect_url = await oauth_provider_service.begin_authorization(
            db,
            response_type=response_type,
            client_id=client_id,
            redirect_uri=redirect_uri,
            scope=scope,
            state=state,
            code_challenge=code_challenge,
            code_challenge_method=code_challenge_method,
        )
        return RedirectResponse(redirect_url, status_code=302)
    except OAuthProviderError as exc:
        redirect_url = oauth_provider_service.authorization_error_redirect(
            db,
            client_id=client_id,
            redirect_uri=redirect_uri,
            state=state,
            error=exc.error,
            description=exc.description,
        )
        if redirect_url:
            return RedirectResponse(redirect_url, status_code=302)
        return _oauth_error(exc)


@router.get(
    "/authorization-requests/{request_id}",
    response_model=OAuthAuthorizationRequestResponse,
)
async def get_authorization_request(
    request_id: str,
    db: Session = Depends(get_db),
    _: User = Depends(security.get_current_user),
):
    try:
        return await oauth_provider_service.get_authorization_request(db, request_id)
    except OAuthProviderError as exc:
        return _oauth_error(exc)


@router.post(
    "/authorization-requests/{request_id}/approve",
    response_model=OAuthAuthorizationDecisionResponse,
)
async def approve_authorization_request(
    request_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    try:
        return await oauth_provider_service.decide_authorization(
            db, request_id=request_id, user=current_user, approved=True
        )
    except OAuthProviderError as exc:
        return _oauth_error(exc)


@router.post(
    "/authorization-requests/{request_id}/deny",
    response_model=OAuthAuthorizationDecisionResponse,
)
async def deny_authorization_request(
    request_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    try:
        return await oauth_provider_service.decide_authorization(
            db, request_id=request_id, user=current_user, approved=False
        )
    except OAuthProviderError as exc:
        return _oauth_error(exc)


@router.post("/token", response_model=OAuthTokenResponse)
async def token(
    response: Response,
    grant_type: str = Form(...),
    client_id: str = Form(default=""),
    client_secret: str | None = Form(default=None),
    code: str | None = Form(default=None),
    redirect_uri: str | None = Form(default=None),
    code_verifier: str | None = Form(default=None),
    refresh_token: str | None = Form(default=None),
    authorization: str = Header(default=""),
    db: Session = Depends(get_db),
):
    response.headers["Cache-Control"] = "no-store"
    response.headers["Pragma"] = "no-cache"
    try:
        resolved_client_id, resolved_secret = _parse_client_credentials(
            authorization, client_id, client_secret
        )
        if grant_type == "authorization_code":
            if not code or not redirect_uri or not code_verifier:
                raise OAuthProviderError(
                    "invalid_request",
                    "code, redirect_uri, and code_verifier are required",
                )
            return await oauth_provider_service.exchange_code(
                db,
                client_id=resolved_client_id,
                client_secret=resolved_secret,
                code=code,
                redirect_uri=redirect_uri,
                code_verifier=code_verifier,
            )
        if grant_type == "refresh_token":
            if not refresh_token:
                raise OAuthProviderError("invalid_request", "refresh_token is required")
            return oauth_provider_service.refresh(
                db,
                client_id=resolved_client_id,
                client_secret=resolved_secret,
                refresh_token=refresh_token,
            )
        raise OAuthProviderError(
            "unsupported_grant_type", "Unsupported OAuth grant type"
        )
    except OAuthProviderError as exc:
        return _oauth_error(exc)


@router.post("/revoke", status_code=200)
async def revoke(
    token: str = Form(...),
    token_type_hint: str | None = Form(default=None),
    client_id: str = Form(default=""),
    client_secret: str | None = Form(default=None),
    authorization: str = Header(default=""),
    db: Session = Depends(get_db),
):
    try:
        resolved_client_id, resolved_secret = _parse_client_credentials(
            authorization, client_id, client_secret
        )
        oauth_provider_service.revoke(
            db,
            client_id=resolved_client_id,
            client_secret=resolved_secret,
            token=token,
            token_type_hint=token_type_hint,
        )
        return Response(status_code=200)
    except OAuthProviderError as exc:
        return _oauth_error(exc)


@router.get("/userinfo", response_model=OAuthUserInfoResponse)
async def userinfo(
    authorization: str = Header(default=""),
    db: Session = Depends(get_db),
):
    scheme, access_token = get_authorization_scheme_param(authorization)
    if scheme.lower() != "bearer" or not access_token:
        return _oauth_error(
            OAuthProviderError(
                "invalid_token", "External Bearer access token is required", 401
            )
        )
    try:
        return oauth_provider_service.userinfo(db, access_token)
    except OAuthProviderError as exc:
        return _oauth_error(exc)
