"""GitHub OAuth flow for user-scoped connector authorization."""

from __future__ import annotations

import base64
import hashlib
import secrets
import time
import uuid
from datetime import datetime, timedelta, timezone
from urllib.parse import urlencode

import httpx
from fastapi import HTTPException, status
from jose import JWTError, jwt
from sqlalchemy.orm import Session

from app.core.cache import cache_manager
from app.core.config import settings
from app.schemas.connector import (
    ConnectorOAuthSessionCreateResponse,
    ConnectorOAuthSessionPollResponse,
)
from app.services.connector_connections import (
    ConnectorConnection,
    connector_connection_service,
)

GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize"
GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token"
GITHUB_USER_URL = "https://api.github.com/user"
GITHUB_REVOKE_URL = "https://api.github.com/applications/{client_id}/token"
SESSION_KEY_PREFIX = "connector_oauth_session:"
POLL_INTERVAL_SECONDS = 2


def _session_key(session_id: str) -> str:
    return f"{SESSION_KEY_PREFIX}{session_id}"


def _state_secret() -> str:
    return settings.CONNECTOR_OAUTH_STATE_SECRET or settings.OIDC_STATE_SECRET_KEY


def _require_github_config() -> None:
    if not settings.GITHUB_OAUTH_CLIENT_ID or not settings.GITHUB_OAUTH_CLIENT_SECRET:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "GitHub OAuth is not configured",
        )


def _pkce_challenge(verifier: str) -> str:
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    return base64.urlsafe_b64encode(digest).decode("ascii").rstrip("=")


class ConnectorOAuthService:
    """Create and complete OAuth sessions without exposing provider tokens."""

    @staticmethod
    async def create_session(
        *,
        slug: str,
        user_id: int,
    ) -> ConnectorOAuthSessionCreateResponse:
        if slug != "github":
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                "OAuth provider is not supported",
            )
        _require_github_config()
        now = int(time.time())
        ttl = settings.CONNECTOR_OAUTH_SESSION_TTL_SECONDS
        session_id = str(uuid.uuid4())
        poll_token = secrets.token_urlsafe(32)
        nonce = secrets.token_urlsafe(24)
        verifier = secrets.token_urlsafe(64)
        state = jwt.encode(
            {
                "sub": str(user_id),
                "connector": slug,
                "session_id": session_id,
                "nonce": nonce,
                "aud": "wegent-connector-oauth",
                "iat": now,
                "exp": now + ttl,
            },
            _state_secret(),
            algorithm=settings.ALGORITHM,
        )
        session_data = {
            "status": "pending",
            "slug": slug,
            "user_id": user_id,
            "poll_token": poll_token,
            "nonce": nonce,
            "code_verifier": verifier,
            "expires_at": now + ttl,
        }
        if not await cache_manager.set(
            _session_key(session_id), session_data, expire=ttl
        ):
            raise HTTPException(
                status.HTTP_500_INTERNAL_SERVER_ERROR,
                "Failed to create connector authorization session",
            )
        params = urlencode(
            {
                "client_id": settings.GITHUB_OAUTH_CLIENT_ID,
                "redirect_uri": settings.GITHUB_OAUTH_REDIRECT_URI,
                "scope": settings.GITHUB_OAUTH_SCOPES,
                "state": state,
                "code_challenge": _pkce_challenge(verifier),
                "code_challenge_method": "S256",
            }
        )
        return ConnectorOAuthSessionCreateResponse(
            session_id=session_id,
            poll_token=poll_token,
            authorize_url=f"{GITHUB_AUTHORIZE_URL}?{params}",
            expires_at=now + ttl,
            poll_interval_seconds=POLL_INTERVAL_SECONDS,
        )

    @staticmethod
    async def poll_session(
        db: Session,
        *,
        session_id: str,
        poll_token: str,
        user_id: int,
    ) -> ConnectorOAuthSessionPollResponse:
        session = await ConnectorOAuthService._read_session(session_id)
        if (
            not secrets.compare_digest(str(session.get("poll_token") or ""), poll_token)
            or int(session.get("user_id") or 0) != user_id
        ):
            raise HTTPException(
                status.HTTP_401_UNAUTHORIZED,
                "Invalid connector authorization polling token",
            )
        current_status = str(session.get("status") or "pending")
        if current_status == "pending":
            return ConnectorOAuthSessionPollResponse(status="pending")
        if current_status == "declined":
            return ConnectorOAuthSessionPollResponse(status="declined")
        if current_status != "success":
            return ConnectorOAuthSessionPollResponse(
                status="failed",
                error=str(session.get("error") or "Connector authorization failed"),
            )
        connection = connector_connection_service.get(
            db,
            slug=str(session["slug"]),
            user_id=user_id,
        )
        session["status"] = "claimed"
        await ConnectorOAuthService._write_session(session_id, session)
        return ConnectorOAuthSessionPollResponse(
            status="success",
            connection=connector_connection_service.response(connection),
        )

    @staticmethod
    async def complete_callback(
        db: Session,
        *,
        code: str | None,
        state_token: str,
        provider_error: str | None = None,
    ) -> str:
        claims = ConnectorOAuthService._decode_state(state_token)
        session_id = str(claims["session_id"])
        session = await ConnectorOAuthService._read_session(session_id)
        ConnectorOAuthService._validate_callback_session(claims, session)
        if str(session.get("status")) != "pending":
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "Connector authorization session has already completed",
            )
        if provider_error:
            session.update({"status": "declined", "error": provider_error})
            await ConnectorOAuthService._write_session(session_id, session)
            return "GitHub authorization was declined. You can close this window."
        if not code:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                "GitHub authorization code is missing",
            )
        try:
            token_payload = await ConnectorOAuthService._exchange_code(
                code=code,
                verifier=str(session["code_verifier"]),
            )
            access_token = str(token_payload.get("access_token") or "")
            if not access_token:
                raise ValueError("GitHub did not return an access token")
            account_name = await ConnectorOAuthService._fetch_github_login(access_token)
            scope_value = str(token_payload.get("scope") or "")
            scopes = [value for value in scope_value.replace(",", " ").split() if value]
            expires_in = token_payload.get("expires_in")
            expires_at = (
                datetime.now(timezone.utc).replace(tzinfo=None)
                + timedelta(seconds=int(expires_in))
                if expires_in
                else None
            )
            connector_connection_service.save_oauth_connection(
                db,
                slug=str(session["slug"]),
                user_id=int(session["user_id"]),
                access_token=access_token,
                refresh_token=token_payload.get("refresh_token"),
                token_type=str(token_payload.get("token_type") or "bearer"),
                granted_scopes=scopes,
                external_account_name=account_name,
                expires_at=expires_at,
            )
        except (httpx.HTTPError, ValueError) as exc:
            db.rollback()
            session.update(
                {
                    "status": "failed",
                    "error": "GitHub authorization could not be completed",
                }
            )
            await ConnectorOAuthService._write_session(session_id, session)
            raise HTTPException(
                status.HTTP_502_BAD_GATEWAY,
                "GitHub authorization could not be completed",
            ) from exc
        session.update({"status": "success", "completed_at": int(time.time())})
        session.pop("code_verifier", None)
        await ConnectorOAuthService._write_session(session_id, session)
        return "GitHub is connected. You can close this window."

    @staticmethod
    async def disconnect(db: Session, *, slug: str, user_id: int) -> bool:
        connection = connector_connection_service.get(db, slug=slug, user_id=user_id)
        if not connection:
            return False
        token = connection.access_token()
        if slug == "github" and token and settings.GITHUB_OAUTH_CLIENT_ID:
            try:
                async with httpx.AsyncClient(timeout=10) as client:
                    await client.request(
                        "DELETE",
                        GITHUB_REVOKE_URL.format(
                            client_id=settings.GITHUB_OAUTH_CLIENT_ID
                        ),
                        auth=(
                            settings.GITHUB_OAUTH_CLIENT_ID,
                            settings.GITHUB_OAUTH_CLIENT_SECRET,
                        ),
                        json={"access_token": token},
                        headers={"Accept": "application/vnd.github+json"},
                    )
            except httpx.HTTPError:
                pass
        return connector_connection_service.disconnect(db, slug=slug, user_id=user_id)

    @staticmethod
    async def refresh_connection(
        db: Session,
        connection: ConnectorConnection,
    ) -> ConnectorConnection | None:
        refresh_token = connection.refresh_token()
        if connection.slug != "github" or not refresh_token:
            return None
        _require_github_config()
        try:
            async with httpx.AsyncClient(timeout=15) as client:
                response = await client.post(
                    GITHUB_TOKEN_URL,
                    headers={"Accept": "application/json"},
                    data={
                        "client_id": settings.GITHUB_OAUTH_CLIENT_ID,
                        "client_secret": settings.GITHUB_OAUTH_CLIENT_SECRET,
                        "grant_type": "refresh_token",
                        "refresh_token": refresh_token,
                    },
                )
                response.raise_for_status()
                payload = response.json()
            access_token = str(payload.get("access_token") or "")
            if not access_token or payload.get("error"):
                raise ValueError("GitHub token refresh failed")
            scope_value = str(payload.get("scope") or "")
            scopes = (
                [value for value in scope_value.replace(",", " ").split() if value]
                if scope_value
                else connection.granted_scopes
            )
            expires_in = payload.get("expires_in")
            return connector_connection_service.save_oauth_connection(
                db,
                slug=connection.slug,
                user_id=connection.user_id,
                access_token=access_token,
                refresh_token=str(payload.get("refresh_token") or refresh_token),
                token_type=str(payload.get("token_type") or connection.token_type),
                granted_scopes=scopes,
                external_account_name=connection.external_account_name,
                expires_at=(
                    datetime.now(timezone.utc).replace(tzinfo=None)
                    + timedelta(seconds=int(expires_in))
                    if expires_in
                    else None
                ),
            )
        except (httpx.HTTPError, ValueError):
            connector_connection_service.set_status(db, connection, "expired")
            return None

    @staticmethod
    async def _exchange_code(*, code: str, verifier: str) -> dict:
        async with httpx.AsyncClient(timeout=15) as client:
            response = await client.post(
                GITHUB_TOKEN_URL,
                headers={"Accept": "application/json"},
                data={
                    "client_id": settings.GITHUB_OAUTH_CLIENT_ID,
                    "client_secret": settings.GITHUB_OAUTH_CLIENT_SECRET,
                    "code": code,
                    "redirect_uri": settings.GITHUB_OAUTH_REDIRECT_URI,
                    "code_verifier": verifier,
                },
            )
            response.raise_for_status()
            payload = response.json()
        if payload.get("error"):
            raise ValueError(str(payload.get("error_description") or payload["error"]))
        return payload

    @staticmethod
    async def _fetch_github_login(access_token: str) -> str:
        async with httpx.AsyncClient(timeout=15) as client:
            response = await client.get(
                GITHUB_USER_URL,
                headers={
                    "Accept": "application/vnd.github+json",
                    "Authorization": f"Bearer {access_token}",
                    "X-GitHub-Api-Version": "2022-11-28",
                },
            )
            response.raise_for_status()
            payload = response.json()
        login = payload.get("login")
        if not isinstance(login, str) or not login:
            raise ValueError("GitHub account login is missing")
        return login

    @staticmethod
    def _decode_state(state_token: str) -> dict:
        try:
            return jwt.decode(
                state_token,
                _state_secret(),
                algorithms=[settings.ALGORITHM],
                audience="wegent-connector-oauth",
            )
        except JWTError as exc:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                "Invalid or expired connector OAuth state",
            ) from exc

    @staticmethod
    def _validate_callback_session(claims: dict, session: dict) -> None:
        if (
            str(claims.get("connector")) != str(session.get("slug"))
            or int(claims.get("sub") or 0) != int(session.get("user_id") or 0)
            or not secrets.compare_digest(
                str(claims.get("nonce") or ""),
                str(session.get("nonce") or ""),
            )
        ):
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                "Connector OAuth state does not match the session",
            )

    @staticmethod
    async def _read_session(session_id: str) -> dict:
        try:
            uuid.UUID(session_id, version=4)
        except ValueError as exc:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                "Invalid connector authorization session",
            ) from exc
        session = await cache_manager.get(_session_key(session_id))
        if not isinstance(session, dict):
            raise HTTPException(
                status.HTTP_404_NOT_FOUND,
                "Connector authorization session expired or was not found",
            )
        return session

    @staticmethod
    async def _write_session(session_id: str, session: dict) -> None:
        remaining = max(1, int(session.get("expires_at") or 0) - int(time.time()))
        if not await cache_manager.set(
            _session_key(session_id), session, expire=remaining
        ):
            raise HTTPException(
                status.HTTP_500_INTERNAL_SERVER_ERROR,
                "Failed to update connector authorization session",
            )


connector_oauth_service = ConnectorOAuthService()
