# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""GitHub OAuth flow with detached DB phases and bounded payload work."""

from __future__ import annotations

import base64
import hashlib
import secrets
import time
import uuid
from collections.abc import Callable
from dataclasses import dataclass, replace
from datetime import datetime, timedelta, timezone
from typing import Any
from urllib.parse import urlencode

import httpx
from fastapi import HTTPException, status
from jose import JWTError, jwt
from sqlalchemy.orm import Session

from app.core.cache import cache_manager
from app.core.config import settings
from app.core.payload_codec import run_payload_codec
from app.schemas.connector import (
    ConnectorConnectionResponse,
    ConnectorOAuthSessionCreateResponse,
    ConnectorOAuthSessionPollResponse,
)
from app.services.chat.storage.db import run_sync_in_executor
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
MAX_OAUTH_RESPONSE_BYTES = 256 * 1024


@dataclass(frozen=True)
class OAuthSessionState:
    status: str
    slug: str
    user_id: int
    poll_token: str
    nonce: str
    code_verifier: str | None
    expires_at: int
    error: str | None = None
    completed_at: int | None = None


@dataclass(frozen=True)
class OAuthSessionCreation:
    response: ConnectorOAuthSessionCreateResponse
    state: OAuthSessionState


@dataclass(frozen=True)
class GitHubToken:
    access_token: str
    refresh_token: str | None
    token_type: str
    scopes: tuple[str, ...]
    expires_in: int | None


@dataclass(frozen=True)
class RefreshPlan:
    slug: str
    user_id: int
    refresh_token: str
    token_type: str
    granted_scopes: tuple[str, ...]
    external_account_name: str | None


def _session_key(session_id: str) -> str:
    return f"{SESSION_KEY_PREFIX}{session_id}"


def _state_secret() -> str:
    return settings.CONNECTOR_OAUTH_STATE_SECRET or settings.OIDC_STATE_SECRET_KEY


def _require_github_config() -> None:
    if not settings.GITHUB_OAUTH_CLIENT_ID or not settings.GITHUB_OAUTH_CLIENT_SECRET:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE, "GitHub OAuth is not configured"
        )


def _pkce_challenge(verifier: str) -> str:
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    return base64.urlsafe_b64encode(digest).decode("ascii").rstrip("=")


class ConnectorOAuthService:
    """Create and complete OAuth sessions without retaining ORM state."""

    def __init__(self, session_factory: Callable[[], Session] | None = None) -> None:
        self._configured_session_factory = session_factory

    def _session_factory(self) -> Session:
        if self._configured_session_factory is not None:
            return self._configured_session_factory()
        from app.db.session import SessionLocal

        return SessionLocal()

    async def create_session(
        self,
        *,
        slug: str,
        user_id: int,
    ) -> ConnectorOAuthSessionCreateResponse:
        creation = await run_payload_codec(
            self._prepare_session,
            slug,
            user_id,
            payload_hint=slug,
            force_offload=True,
        )
        await self._write_session(creation.response.session_id, creation.state)
        return creation.response

    async def poll_session(
        self,
        *,
        session_id: str,
        poll_token: str,
        user_id: int,
    ) -> ConnectorOAuthSessionPollResponse:
        session = await self._read_session(session_id)
        await run_payload_codec(
            self._validate_poll,
            session,
            poll_token,
            user_id,
            payload_hint=poll_token,
            force_offload=True,
        )
        if session.status == "pending":
            return await run_payload_codec(
                self._poll_response,
                "pending",
                None,
                None,
                payload_hint=session,
                force_offload=True,
            )
        if session.status == "declined":
            return await run_payload_codec(
                self._poll_response,
                "declined",
                None,
                None,
                payload_hint=session,
                force_offload=True,
            )
        if session.status != "success":
            return await run_payload_codec(
                self._poll_response,
                "failed",
                session.error or "Connector authorization failed",
                None,
                payload_hint=session,
                force_offload=True,
            )
        connection = await run_sync_in_executor(
            self._load_connection_response_sync,
            session.slug,
            user_id,
        )
        await self._write_session(
            session_id,
            replace(session, status="claimed"),
        )
        return await run_payload_codec(
            self._poll_response,
            "success",
            None,
            connection,
            payload_hint=connection,
            force_offload=True,
        )

    async def complete_callback(
        self,
        *,
        code: str | None,
        state_token: str,
        provider_error: str | None = None,
    ) -> str:
        claims = await run_payload_codec(
            self._decode_state,
            state_token,
            payload_hint=state_token,
            force_offload=True,
        )
        session_id = str(claims["session_id"])
        session = await self._read_session(session_id)
        await run_payload_codec(
            self._validate_callback_session,
            claims,
            session,
            payload_hint=state_token,
            force_offload=True,
        )
        if session.status != "pending":
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "Connector authorization session has already completed",
            )
        if provider_error:
            await self._write_session(
                session_id,
                replace(session, status="declined", error=provider_error),
            )
            return "GitHub authorization was declined. You can close this window."
        if not code:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST, "GitHub authorization code is missing"
            )
        try:
            token = await self._exchange_code(
                code=code,
                verifier=session.code_verifier or "",
            )
            account_name = await self._fetch_github_login(token.access_token)
            await run_sync_in_executor(
                self._save_callback_connection_sync,
                session.slug,
                session.user_id,
                token,
                account_name,
            )
        except (httpx.HTTPError, ValueError) as exc:
            await self._write_session(
                session_id,
                replace(
                    session,
                    status="failed",
                    error="GitHub authorization could not be completed",
                ),
            )
            raise HTTPException(
                status.HTTP_502_BAD_GATEWAY,
                "GitHub authorization could not be completed",
            ) from exc
        await self._write_session(
            session_id,
            replace(
                session,
                status="success",
                completed_at=int(time.time()),
                code_verifier=None,
            ),
        )
        return "GitHub is connected. You can close this window."

    async def disconnect(self, *, slug: str, user_id: int) -> bool:
        token = await run_sync_in_executor(
            self._load_disconnect_token_sync,
            slug,
            user_id,
        )
        if token is None:
            return False
        if slug == "github" and token and settings.GITHUB_OAUTH_CLIENT_ID:
            try:
                request = await run_payload_codec(
                    self._build_revoke_request,
                    token,
                    payload_hint=token,
                    force_offload=True,
                )
                async with httpx.AsyncClient(timeout=10) as client:
                    response = await client.send(request, stream=True)
                    await response.aclose()
            except httpx.HTTPError:
                pass
        return await run_sync_in_executor(
            self._disconnect_sync,
            slug,
            user_id,
        )

    async def refresh_connection(
        self,
        *,
        slug: str,
        user_id: int,
    ) -> ConnectorConnection | None:
        plan = await run_sync_in_executor(
            self._prepare_refresh_sync,
            slug,
            user_id,
        )
        if plan is None:
            return None
        _require_github_config()
        try:
            token = await self._refresh_github_token(plan)
            return await run_sync_in_executor(
                self._save_refresh_sync,
                plan,
                token,
            )
        except (httpx.HTTPError, ValueError):
            await run_sync_in_executor(
                self._mark_expired_sync,
                slug,
                user_id,
            )
            return None

    @staticmethod
    def _prepare_session(slug: str, user_id: int) -> OAuthSessionCreation:
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
        state_token = jwt.encode(
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
        params = urlencode(
            {
                "client_id": settings.GITHUB_OAUTH_CLIENT_ID,
                "redirect_uri": settings.GITHUB_OAUTH_REDIRECT_URI,
                "scope": settings.GITHUB_OAUTH_SCOPES,
                "state": state_token,
                "code_challenge": _pkce_challenge(verifier),
                "code_challenge_method": "S256",
            }
        )
        return OAuthSessionCreation(
            response=ConnectorOAuthSessionCreateResponse(
                session_id=session_id,
                poll_token=poll_token,
                authorize_url=f"{GITHUB_AUTHORIZE_URL}?{params}",
                expires_at=now + ttl,
                poll_interval_seconds=POLL_INTERVAL_SECONDS,
            ),
            state=OAuthSessionState(
                status="pending",
                slug=slug,
                user_id=user_id,
                poll_token=poll_token,
                nonce=nonce,
                code_verifier=verifier,
                expires_at=now + ttl,
            ),
        )

    @staticmethod
    def _poll_response(
        status_value: str,
        error: str | None,
        connection: ConnectorConnectionResponse | None,
    ) -> ConnectorOAuthSessionPollResponse:
        return ConnectorOAuthSessionPollResponse(
            status=status_value,
            error=error,
            connection=connection,
        )

    def _load_connection_response_sync(self, slug: str, user_id: int):
        with self._session_factory() as db:
            return connector_connection_service.response(
                connector_connection_service.get(db, slug=slug, user_id=user_id)
            )

    def _save_callback_connection_sync(
        self,
        slug: str,
        user_id: int,
        token: GitHubToken,
        account_name: str,
    ) -> None:
        expires_at = (
            datetime.now(timezone.utc).replace(tzinfo=None)
            + timedelta(seconds=token.expires_in)
            if token.expires_in is not None
            else None
        )
        with self._session_factory() as db:
            connector_connection_service.save_oauth_connection(
                db,
                slug=slug,
                user_id=user_id,
                access_token=token.access_token,
                refresh_token=token.refresh_token,
                token_type=token.token_type,
                granted_scopes=list(token.scopes),
                external_account_name=account_name,
                expires_at=expires_at,
            )

    def _load_disconnect_token_sync(self, slug: str, user_id: int) -> str | None:
        with self._session_factory() as db:
            connection = connector_connection_service.get(
                db, slug=slug, user_id=user_id
            )
            if connection is None:
                return None
            return connection.access_token()

    def _disconnect_sync(self, slug: str, user_id: int) -> bool:
        with self._session_factory() as db:
            return connector_connection_service.disconnect(
                db, slug=slug, user_id=user_id
            )

    def _prepare_refresh_sync(
        self,
        slug: str,
        user_id: int,
    ) -> RefreshPlan | None:
        with self._session_factory() as db:
            connection = connector_connection_service.get(
                db, slug=slug, user_id=user_id
            )
            if connection is None:
                return None
            refresh_token = connection.refresh_token()
            if connection.slug != "github" or not refresh_token:
                return None
            return RefreshPlan(
                slug=connection.slug,
                user_id=connection.user_id,
                refresh_token=refresh_token,
                token_type=connection.token_type,
                granted_scopes=connection.granted_scopes,
                external_account_name=connection.external_account_name,
            )

    def _save_refresh_sync(
        self,
        plan: RefreshPlan,
        token: GitHubToken,
    ) -> ConnectorConnection:
        expires_at = (
            datetime.now(timezone.utc).replace(tzinfo=None)
            + timedelta(seconds=token.expires_in)
            if token.expires_in is not None
            else None
        )
        with self._session_factory() as db:
            return connector_connection_service.save_oauth_connection(
                db,
                slug=plan.slug,
                user_id=plan.user_id,
                access_token=token.access_token,
                refresh_token=token.refresh_token or plan.refresh_token,
                token_type=token.token_type or plan.token_type,
                granted_scopes=list(token.scopes or plan.granted_scopes),
                external_account_name=plan.external_account_name,
                expires_at=expires_at,
            )

    def _mark_expired_sync(self, slug: str, user_id: int) -> None:
        with self._session_factory() as db:
            connection = connector_connection_service.get(
                db, slug=slug, user_id=user_id
            )
            if connection is not None:
                connector_connection_service.set_status(db, connection, "expired")

    async def _refresh_github_token(self, plan: RefreshPlan) -> GitHubToken:
        request = await run_payload_codec(
            self._build_refresh_request,
            plan,
            payload_hint=plan.refresh_token,
            force_offload=True,
        )
        content = await self._send_bounded(request, timeout=15)
        return await run_payload_codec(
            self._parse_token_payload,
            content,
            payload_hint=content,
            force_offload=True,
        )

    async def _exchange_code(self, *, code: str, verifier: str) -> GitHubToken:
        request = await run_payload_codec(
            self._build_exchange_request,
            code,
            verifier,
            payload_hint=code,
            force_offload=True,
        )
        content = await self._send_bounded(request, timeout=15)
        return await run_payload_codec(
            self._parse_token_payload,
            content,
            payload_hint=content,
            force_offload=True,
        )

    async def _fetch_github_login(self, access_token: str) -> str:
        request = await run_payload_codec(
            self._build_user_request,
            access_token,
            payload_hint=access_token,
            force_offload=True,
        )
        content = await self._send_bounded(request, timeout=15)
        return await run_payload_codec(
            self._parse_github_login,
            content,
            payload_hint=content,
            force_offload=True,
        )

    @staticmethod
    async def _send_bounded(request: httpx.Request, *, timeout: int) -> bytes:
        async with httpx.AsyncClient(timeout=timeout) as client:
            response = await client.send(request, stream=True)
            try:
                await run_payload_codec(
                    response.raise_for_status,
                    payload_hint=response.status_code,
                    force_offload=True,
                )
                return await ConnectorOAuthService._bounded_response_body(response)
            finally:
                await response.aclose()

    @staticmethod
    async def _bounded_response_body(response: httpx.Response) -> bytes:
        declared = response.headers.get("content-length")
        try:
            declared_size = int(declared) if declared else None
        except ValueError:
            declared_size = None
        if declared_size is not None and declared_size > MAX_OAUTH_RESPONSE_BYTES:
            raise ValueError("OAuth response exceeds the size limit")
        body = bytearray()
        async for chunk in response.aiter_bytes():
            body.extend(chunk)
            if len(body) > MAX_OAUTH_RESPONSE_BYTES:
                raise ValueError("OAuth response exceeds the size limit")
        return bytes(body)

    @staticmethod
    def _build_exchange_request(code: str, verifier: str) -> httpx.Request:
        return httpx.Request(
            "POST",
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

    @staticmethod
    def _build_refresh_request(plan: RefreshPlan) -> httpx.Request:
        return httpx.Request(
            "POST",
            GITHUB_TOKEN_URL,
            headers={"Accept": "application/json"},
            data={
                "client_id": settings.GITHUB_OAUTH_CLIENT_ID,
                "client_secret": settings.GITHUB_OAUTH_CLIENT_SECRET,
                "grant_type": "refresh_token",
                "refresh_token": plan.refresh_token,
            },
        )

    @staticmethod
    def _build_user_request(access_token: str) -> httpx.Request:
        return httpx.Request(
            "GET",
            GITHUB_USER_URL,
            headers={
                "Accept": "application/vnd.github+json",
                "Authorization": f"Bearer {access_token}",
                "X-GitHub-Api-Version": "2022-11-28",
            },
        )

    @staticmethod
    def _build_revoke_request(access_token: str) -> httpx.Request:
        return httpx.Request(
            "DELETE",
            GITHUB_REVOKE_URL.format(client_id=settings.GITHUB_OAUTH_CLIENT_ID),
            auth=(
                settings.GITHUB_OAUTH_CLIENT_ID,
                settings.GITHUB_OAUTH_CLIENT_SECRET,
            ),
            json={"access_token": access_token},
            headers={"Accept": "application/vnd.github+json"},
        )

    @staticmethod
    def _parse_token_payload(content: bytes) -> GitHubToken:
        payload = json_loads_object(content)
        if payload.get("error"):
            raise ValueError(str(payload.get("error_description") or payload["error"]))
        access_token = str(payload.get("access_token") or "")
        if not access_token:
            raise ValueError("GitHub did not return an access token")
        scope_value = str(payload.get("scope") or "")
        scopes = tuple(
            value for value in scope_value.replace(",", " ").split() if value
        )
        expires_in_raw = payload.get("expires_in")
        return GitHubToken(
            access_token=access_token,
            refresh_token=(
                str(payload["refresh_token"]) if payload.get("refresh_token") else None
            ),
            token_type=str(payload.get("token_type") or "bearer"),
            scopes=scopes,
            expires_in=int(expires_in_raw) if expires_in_raw is not None else None,
        )

    @staticmethod
    def _parse_github_login(content: bytes) -> str:
        login = json_loads_object(content).get("login")
        if not isinstance(login, str) or not login:
            raise ValueError("GitHub account login is missing")
        return login

    @staticmethod
    def _decode_state(state_token: str) -> dict[str, Any]:
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
    def _validate_callback_session(
        claims: dict[str, Any], session: OAuthSessionState
    ) -> None:
        if (
            str(claims.get("connector")) != session.slug
            or int(claims.get("sub") or 0) != session.user_id
            or not secrets.compare_digest(str(claims.get("nonce") or ""), session.nonce)
        ):
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                "Connector OAuth state does not match the session",
            )

    @staticmethod
    def _validate_poll(
        session: OAuthSessionState,
        poll_token: str,
        user_id: int,
    ) -> None:
        if (
            not secrets.compare_digest(session.poll_token, poll_token)
            or session.user_id != user_id
        ):
            raise HTTPException(
                status.HTTP_401_UNAUTHORIZED,
                "Invalid connector authorization polling token",
            )

    async def _read_session(self, session_id: str) -> OAuthSessionState:
        await run_payload_codec(
            self._validate_session_id,
            session_id,
            payload_hint=session_id,
            force_offload=True,
        )
        value = await cache_manager.get(_session_key(session_id))
        if not isinstance(value, dict):
            raise HTTPException(
                status.HTTP_404_NOT_FOUND,
                "Connector authorization session expired or was not found",
            )
        return await run_payload_codec(
            self._session_from_dict,
            value,
            payload_hint=value,
            force_offload=True,
        )

    async def _write_session(
        self,
        session_id: str,
        session: OAuthSessionState,
    ) -> None:
        value = await run_payload_codec(
            self._session_to_dict,
            session,
            payload_hint=session,
            force_offload=True,
        )
        remaining = max(1, session.expires_at - int(time.time()))
        if not await cache_manager.set(
            _session_key(session_id), value, expire=remaining
        ):
            raise HTTPException(
                status.HTTP_500_INTERNAL_SERVER_ERROR,
                "Failed to update connector authorization session",
            )

    @staticmethod
    def _validate_session_id(session_id: str) -> None:
        try:
            uuid.UUID(session_id, version=4)
        except ValueError as exc:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                "Invalid connector authorization session",
            ) from exc

    @staticmethod
    def _session_from_dict(value: dict[str, Any]) -> OAuthSessionState:
        return OAuthSessionState(
            status=str(value.get("status") or "pending"),
            slug=str(value["slug"]),
            user_id=int(value["user_id"]),
            poll_token=str(value["poll_token"]),
            nonce=str(value["nonce"]),
            code_verifier=(
                str(value["code_verifier"]) if value.get("code_verifier") else None
            ),
            expires_at=int(value["expires_at"]),
            error=str(value["error"]) if value.get("error") else None,
            completed_at=(
                int(value["completed_at"]) if value.get("completed_at") else None
            ),
        )

    @staticmethod
    def _session_to_dict(session: OAuthSessionState) -> dict[str, Any]:
        value: dict[str, Any] = {
            "status": session.status,
            "slug": session.slug,
            "user_id": session.user_id,
            "poll_token": session.poll_token,
            "nonce": session.nonce,
            "expires_at": session.expires_at,
        }
        if session.code_verifier is not None:
            value["code_verifier"] = session.code_verifier
        if session.error is not None:
            value["error"] = session.error
        if session.completed_at is not None:
            value["completed_at"] = session.completed_at
        return value


def json_loads_object(content: bytes) -> dict[str, Any]:
    import json

    payload = json.loads(content)
    if not isinstance(payload, dict):
        raise ValueError("GitHub returned an invalid JSON response")
    return payload


connector_oauth_service = ConnectorOAuthService()
