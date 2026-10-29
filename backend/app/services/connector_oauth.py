"""OAuth flows for user-scoped connector authorization."""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import logging
import secrets
import time
import uuid
from datetime import datetime, timedelta, timezone
from urllib.parse import urlencode

import httpx
from fastapi import HTTPException, status
from jose import JWTError, jwt
from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified

from app.core.cache import cache_manager
from app.core.config import settings
from app.core.distributed_lock import distributed_lock
from app.models.user import User
from app.schemas.connector import (
    ConnectorOAuthSessionCreateResponse,
    ConnectorOAuthSessionPollResponse,
)
from app.services.connector_apps import (
    ConnectorApp,
    ConnectorAppService,
    create_connector_http_client,
)
from app.services.connector_connections import (
    ConnectorConnection,
    connector_connection_service,
)
from app.services.connector_oauth_discovery import discover_connector_oauth
from shared.utils.crypto import decrypt_sensitive_data, encrypt_sensitive_data

GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize"
GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token"
GITHUB_USER_URL = "https://api.github.com/user"
GITHUB_REVOKE_URL = "https://api.github.com/applications/{client_id}/token"
SESSION_KEY_PREFIX = "connector_oauth_session:"
POLL_INTERVAL_SECONDS = 2
DISCOVERY_TIMEOUT_SECONDS = 15
logger = logging.getLogger(__name__)


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
        db: Session,
        *,
        slug: str,
        user_id: int,
    ) -> ConnectorOAuthSessionCreateResponse:
        app = ConnectorAppService.get_app_by_slug(db, slug)
        if not app:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Connector app not found")
        if app.auth_type != "oauth2":
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                "Connector app does not use OAuth",
            )
        if slug != "github":
            return await ConnectorOAuthService._create_dynamic_session(
                db, app=app, user_id=user_id
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
            "oauth": "github",
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
    async def _create_dynamic_session(
        db: Session,
        *,
        app: ConnectorApp,
        user_id: int,
    ) -> ConnectorOAuthSessionCreateResponse:
        metadata = await discover_connector_oauth(app.mcp_url)
        client = await ConnectorOAuthService._dynamic_client(db, app, metadata)
        now = int(time.time())
        ttl = settings.CONNECTOR_OAUTH_SESSION_TTL_SECONDS
        session_id = str(uuid.uuid4())
        poll_token = secrets.token_urlsafe(32)
        nonce = secrets.token_urlsafe(24)
        verifier = secrets.token_urlsafe(64)
        state = jwt.encode(
            {
                "sub": str(user_id),
                "connector": app.slug,
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
            "slug": app.slug,
            "user_id": user_id,
            "poll_token": poll_token,
            "nonce": nonce,
            "code_verifier": verifier,
            "oauth": "dynamic",
            "resource": app.mcp_url,
            "authorization_endpoint": metadata["authorization_endpoint"],
            "token_endpoint": metadata["token_endpoint"],
            "redirect_uri": settings.CONNECTOR_OAUTH_REDIRECT_URI,
            "client_id": client["client_id"],
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
                "response_type": "code",
                "client_id": client["client_id"],
                "redirect_uri": settings.CONNECTOR_OAUTH_REDIRECT_URI,
                "scope": app.oauth_scope or metadata.get("scope") or "",
                "resource": app.mcp_url,
                "state": state,
                "code_challenge": _pkce_challenge(verifier),
                "code_challenge_method": "S256",
            }
        )
        return ConnectorOAuthSessionCreateResponse(
            session_id=session_id,
            poll_token=poll_token,
            authorize_url=f"{metadata['authorization_endpoint']}?{params}",
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
            return "Connector authorization was declined. You can close this window."
        if not code:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                "GitHub authorization code is missing",
            )
        try:
            if str(session.get("oauth")) == "dynamic":
                token_payload = await ConnectorOAuthService._exchange_dynamic_code(
                    session=session, code=code
                )
            else:
                token_payload = await ConnectorOAuthService._exchange_code(
                    code=code,
                    verifier=str(session["code_verifier"]),
                )
            access_token = str(token_payload.get("access_token") or "")
            if not access_token:
                raise ValueError("Connector did not return an access token")
            account_name = (
                await ConnectorOAuthService._fetch_github_login(access_token)
                if str(session.get("oauth")) == "github"
                else None
            )
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
            if str(session.get("oauth")) == "dynamic":
                await ConnectorOAuthService._cache_authorized_tools(db, session)
        except (httpx.HTTPError, ValueError) as exc:
            db.rollback()
            session.update(
                {
                    "status": "failed",
                    "error": "Connector authorization could not be completed",
                }
            )
            await ConnectorOAuthService._write_session(session_id, session)
            raise HTTPException(
                status.HTTP_502_BAD_GATEWAY,
                "Connector authorization could not be completed",
            ) from exc
        session.update({"status": "success", "completed_at": int(time.time())})
        session.pop("code_verifier", None)
        await ConnectorOAuthService._write_session(session_id, session)
        return "Connector is connected. You can close this window."

    @staticmethod
    async def _cache_authorized_tools(db: Session, session: dict) -> None:
        """Populate last-known tools without turning discovery into an auth failure."""
        try:
            app = ConnectorAppService.get_app_by_slug(db, str(session["slug"]))
            user = db.get(User, int(session["user_id"]))
            if not app or not user:
                return
            from app.services.connector_runtime import connector_runtime_service

            await connector_runtime_service.refresh_tool_summary_cache(db, app, user)
        except Exception as exc:
            logger.warning(
                "Failed to cache tools for connector '%s' after authorization: %s",
                session.get("slug"),
                exc,
            )

    @staticmethod
    async def disconnect(db: Session, *, slug: str, user_id: int) -> bool:
        connection = connector_connection_service.get(db, slug=slug, user_id=user_id)
        if not connection:
            return False
        token = connection.access_token()
        if slug == "github" and token and settings.GITHUB_OAUTH_CLIENT_ID:
            try:
                async with create_connector_http_client(
                    timeout=httpx.Timeout(10)
                ) as client:
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
        if not refresh_token:
            return None
        # Every write below is conditional on this grant still being stored.
        # Two refreshes, a re-authorization or a disconnect can race the token
        # endpoint call; the older result must never overwrite the newer state.
        grant = connection.refresh_token_encrypted or ""
        try:
            if connection.slug == "github":
                _require_github_config()
                token_endpoint = GITHUB_TOKEN_URL
                data = {
                    "client_id": settings.GITHUB_OAUTH_CLIENT_ID,
                    "client_secret": settings.GITHUB_OAUTH_CLIENT_SECRET,
                    "grant_type": "refresh_token",
                    "refresh_token": refresh_token,
                }
            else:
                app = ConnectorAppService.get_app_by_slug(db, connection.slug)
                if not app:
                    return None
                client = ConnectorOAuthService._stored_dynamic_client(app)
                if not client:
                    return None
                token_endpoint = str(client["token_endpoint"])
                data = {
                    "client_id": str(client["client_id"]),
                    "grant_type": "refresh_token",
                    "refresh_token": refresh_token,
                }
                resource = str(client.get("resource") or "")
                if resource:
                    data["resource"] = resource
            async with create_connector_http_client(
                timeout=httpx.Timeout(DISCOVERY_TIMEOUT_SECONDS)
            ) as client:
                response = await client.post(
                    token_endpoint,
                    headers={"Accept": "application/json"},
                    data=data,
                )
                response.raise_for_status()
                payload = response.json()
            access_token = str(payload.get("access_token") or "")
            if not access_token or payload.get("error"):
                raise ValueError("Connector token refresh failed")
            scope_value = str(payload.get("scope") or "")
            scopes = (
                [value for value in scope_value.replace(",", " ").split() if value]
                if scope_value
                else connection.granted_scopes
            )
            expires_in = payload.get("expires_in")
            saved = connector_connection_service.save_oauth_connection(
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
                expected_refresh_token_encrypted=grant,
            )
            if saved is not None:
                return saved
            return connector_connection_service.get(
                db, slug=connection.slug, user_id=connection.user_id
            )
        except httpx.HTTPStatusError as error:
            # The endpoint answered, so a rejected grant is final.
            return ConnectorOAuthService._record_refresh_failure(
                db,
                connection,
                grant=grant,
                clear_refresh_token=error.response.status_code < 500,
            )
        except ValueError:
            # The payload carried an OAuth error such as `invalid_grant`.
            return ConnectorOAuthService._record_refresh_failure(
                db, connection, grant=grant, clear_refresh_token=True
            )
        except httpx.HTTPError:
            # Transport failures are transient; keep the refresh token for a retry.
            return ConnectorOAuthService._record_refresh_failure(
                db, connection, grant=grant, clear_refresh_token=False
            )

    @staticmethod
    def _record_refresh_failure(
        db: Session,
        connection: ConnectorConnection,
        *,
        grant: str,
        clear_refresh_token: bool,
    ) -> ConnectorConnection | None:
        """Record a vetoed refresh unless a newer grant already replaced it.

        A superseded request returns the current connection so the caller can
        use the credentials another request just committed; the refresh that
        actually failed returns ``None`` and lets the caller ask for consent.
        """
        recorded = connector_connection_service.reject_refresh_if_current(
            db,
            connection=connection,
            expected_refresh_token_encrypted=grant,
            clear_refresh_token=clear_refresh_token,
        )
        if recorded is not None:
            return None
        return connector_connection_service.get(
            db, slug=connection.slug, user_id=connection.user_id
        )

    @staticmethod
    async def _exchange_code(*, code: str, verifier: str) -> dict:
        async with create_connector_http_client(timeout=httpx.Timeout(15)) as client:
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
    async def _exchange_dynamic_code(
        *,
        session: dict,
        code: str,
    ) -> dict:
        async with create_connector_http_client(
            timeout=httpx.Timeout(DISCOVERY_TIMEOUT_SECONDS)
        ) as client:
            response = await client.post(
                str(session["token_endpoint"]),
                data={
                    "grant_type": "authorization_code",
                    "client_id": str(session["client_id"]),
                    "code": code,
                    "redirect_uri": str(session["redirect_uri"]),
                    "code_verifier": str(session["code_verifier"]),
                    "resource": str(session["resource"]),
                },
            )
            response.raise_for_status()
            payload = response.json()
        if not isinstance(payload, dict):
            raise ValueError("Connector token endpoint returned an invalid payload")
        if payload.get("error"):
            raise ValueError(str(payload.get("error_description") or "token exchange"))
        if not payload.get("access_token"):
            raise ValueError("Connector did not return an access token")
        return payload

    @staticmethod
    async def _dynamic_client(
        db: Session,
        app: ConnectorApp,
        metadata: dict,
    ) -> dict:
        stored = ConnectorOAuthService._usable_dynamic_client(app, metadata)
        if stored:
            return stored

        lock_name = f"connector-oauth-client:{app.slug}"
        deadline = time.monotonic() + DISCOVERY_TIMEOUT_SECONDS
        while True:
            async with distributed_lock.acquire_watchdog_context_async(
                lock_name,
                expire_seconds=60,
            ) as acquired:
                if acquired:
                    # Re-read after entering the lock: another instance may have
                    # registered while this request waited for the lock.
                    db.refresh(app.row)
                    app = ConnectorAppService.get_app_by_slug(db, app.slug) or app
                    stored = ConnectorOAuthService._usable_dynamic_client(app, metadata)
                    if stored:
                        return stored
                    return await ConnectorOAuthService._register_dynamic_client(
                        db, app, metadata
                    )

            # The lock holder registers once; competing instances poll the shared
            # Kind row instead of registering duplicate OAuth clients.
            await asyncio.sleep(0.2)
            db.refresh(app.row)
            app = ConnectorAppService.get_app_by_slug(db, app.slug) or app
            stored = ConnectorOAuthService._usable_dynamic_client(app, metadata)
            if stored:
                return stored
            if time.monotonic() >= deadline:
                raise HTTPException(
                    status.HTTP_503_SERVICE_UNAVAILABLE,
                    "Connector OAuth client registration is in progress",
                )

    @staticmethod
    def _usable_dynamic_client(app: ConnectorApp, metadata: dict) -> dict | None:
        stored = ConnectorOAuthService._stored_dynamic_client(app)
        if (
            stored
            and stored.get("issuer") == metadata.get("issuer")
            and stored.get("redirect_uri") == settings.CONNECTOR_OAUTH_REDIRECT_URI
        ):
            return stored
        return None

    @staticmethod
    async def _register_dynamic_client(
        db: Session,
        app: ConnectorApp,
        metadata: dict,
    ) -> dict:
        registration_endpoint = metadata.get("registration_endpoint")
        if not registration_endpoint:
            raise HTTPException(
                status.HTTP_502_BAD_GATEWAY,
                "Connector OAuth server does not support client registration",
            )
        body = {
            "client_name": "Wegent",
            "redirect_uris": [settings.CONNECTOR_OAUTH_REDIRECT_URI],
            "grant_types": ["authorization_code", "refresh_token"],
            "response_types": ["code"],
            "token_endpoint_auth_method": "none",
        }
        if app.oauth_scope:
            body["scope"] = app.oauth_scope
        async with create_connector_http_client(
            timeout=httpx.Timeout(DISCOVERY_TIMEOUT_SECONDS)
        ) as client:
            response = await client.post(str(registration_endpoint), json=body)
            response.raise_for_status()
            payload = response.json()
        client_id = str(payload.get("client_id") or "")
        if not client_id:
            raise HTTPException(
                status.HTTP_502_BAD_GATEWAY,
                "Connector OAuth client registration failed",
            )
        client_data = {
            "issuer": metadata["issuer"],
            "resource": metadata["resource"],
            "authorization_endpoint": metadata["authorization_endpoint"],
            "token_endpoint": metadata["token_endpoint"],
            "registration_endpoint": registration_endpoint,
            "redirect_uri": settings.CONNECTOR_OAUTH_REDIRECT_URI,
            "client_id": client_id,
        }
        ConnectorOAuthService._store_dynamic_client(app, client_data)
        db.commit()
        return client_data

    @staticmethod
    def _stored_dynamic_client(app: ConnectorApp) -> dict | None:
        if not app.oauth_client_encrypted:
            return None
        try:
            payload = json.loads(decrypt_sensitive_data(app.oauth_client_encrypted))
        except (TypeError, ValueError):
            return None
        return payload if isinstance(payload, dict) else None

    @staticmethod
    def _store_dynamic_client(app: ConnectorApp, client_data: dict) -> None:
        spec = dict((app.row.json or {}).get("spec") or {})
        spec["oauthClientEncrypted"] = encrypt_sensitive_data(json.dumps(client_data))
        data = dict(app.row.json or {})
        data["spec"] = spec
        app.row.json = data
        flag_modified(app.row, "json")

    @staticmethod
    async def _fetch_github_login(access_token: str) -> str:
        async with create_connector_http_client(timeout=httpx.Timeout(15)) as client:
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
