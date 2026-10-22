# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""OAuth 2.0 authorization for user-level provider MCP servers.

Provider MCP servers such as DingTalk publish RFC 9728 protected-resource
metadata and an RFC 8414 authorization server. Personal StreamableHttp URLs
carry short-lived credentials, so the platform authorizes once, stores the
refresh token encrypted with the user's preferences, and refreshes access
tokens before each task instead of asking the user to paste a new URL.
"""

from __future__ import annotations

import base64
import hashlib
import logging
import secrets
import time
import uuid
from typing import Any
from urllib.parse import urlencode, urlsplit, urlunsplit

import httpx
from fastapi import HTTPException, status
from jose import JWTError, jwt
from sqlalchemy.orm import Session

from app.core.cache import cache_manager
from app.core.config import settings
from app.models.user import User
from app.services.user_mcp_service import MCP_AUTH_MODE_OAUTH, user_mcp_service

logger = logging.getLogger(__name__)

SESSION_KEY_PREFIX = "user_mcp_oauth_session:"
# Browser-binding cookie so a forwarded authorization URL cannot be completed by
# another logged-in user.
BROWSER_BINDING_COOKIE = "wegent_mcp_oauth_binding"
POLL_INTERVAL_SECONDS = 2
STATE_AUDIENCE = "wegent-mcp-oauth"
# Refresh well before expiry so long tasks do not start on a near-dead token.
REFRESH_SKEW_SECONDS = 1800
DISCOVERY_TIMEOUT_SECONDS = 15
# OAuth error code a provider returns when the stored grant is no longer usable.
INVALID_GRANT_ERROR = "invalid_grant"


def _state_secret() -> str:
    """Return the signing key for MCP OAuth state tokens."""
    return (
        settings.MCP_OAUTH_STATE_SECRET
        or settings.CONNECTOR_OAUTH_STATE_SECRET
        or settings.OIDC_STATE_SECRET_KEY
    )


def _session_key(session_id: str) -> str:
    return f"{SESSION_KEY_PREFIX}{session_id}"


def _pkce_challenge(verifier: str) -> str:
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    return base64.urlsafe_b64encode(digest).decode("ascii").rstrip("=")


def _require_secure_url(value: str, *, field: str) -> str:
    """Reject endpoints that could leak tokens over an insecure transport."""
    parsed = urlsplit(value.strip())
    if parsed.scheme == "https" and parsed.hostname:
        return value.strip()
    loopback = parsed.hostname in {"localhost", "127.0.0.1", "[::1]"}
    if parsed.scheme == "http" and loopback:
        return value.strip()
    raise HTTPException(
        status.HTTP_400_BAD_REQUEST,
        f"MCP OAuth {field} must use https",
    )


def is_secure_mcp_url(value: str | None) -> bool:
    """Return whether an MCP URL may carry an OAuth bearer token."""
    if not value:
        return False
    parsed = urlsplit(value.strip())
    if parsed.scheme == "https" and parsed.hostname:
        return True
    return parsed.scheme == "http" and parsed.hostname in {
        "localhost",
        "127.0.0.1",
        "[::1]",
    }


class UserMcpOAuthService:
    """Authorize and refresh user-level provider MCP OAuth credentials."""

    @staticmethod
    async def discover(resource_url: str) -> dict[str, Any]:
        """Resolve protected-resource and authorization-server metadata."""
        resource_url = _require_secure_url(resource_url, field="resource URL")
        async with httpx.AsyncClient(timeout=DISCOVERY_TIMEOUT_SECONDS) as client:
            metadata_url = await UserMcpOAuthService._resource_metadata_url(
                client, resource_url
            )
            resource = await UserMcpOAuthService._get_json(client, metadata_url)
            authorization_servers = resource.get("authorization_servers")
            if not isinstance(authorization_servers, list) or not authorization_servers:
                raise HTTPException(
                    status.HTTP_502_BAD_GATEWAY,
                    "MCP OAuth resource metadata has no authorization server",
                )
            issuer = _require_secure_url(
                str(authorization_servers[0]), field="authorization server"
            )
            metadata = await UserMcpOAuthService._get_json(
                client,
                f"{issuer.rstrip('/')}/.well-known/oauth-authorization-server",
            )

        authorization_endpoint = _require_secure_url(
            str(metadata.get("authorization_endpoint") or ""),
            field="authorization endpoint",
        )
        token_endpoint = _require_secure_url(
            str(metadata.get("token_endpoint") or ""),
            field="token endpoint",
        )
        registration_endpoint = metadata.get("registration_endpoint")
        scopes = metadata.get("scopes_supported")
        return {
            "resource": resource_url,
            "issuer": issuer,
            "authorization_endpoint": authorization_endpoint,
            "token_endpoint": token_endpoint,
            "registration_endpoint": (
                _require_secure_url(
                    str(registration_endpoint), field="registration endpoint"
                )
                if registration_endpoint
                else None
            ),
            "scope": (
                " ".join(str(item) for item in scopes)
                if isinstance(scopes, list)
                else ""
            ),
        }

    @staticmethod
    async def create_session(
        db: Session,
        *,
        user: User,
        provider_id: str,
        service_id: str,
    ) -> dict[str, Any]:
        """Start an authorization-code session and return the authorize URL."""
        config = user_mcp_service.get_provider_service_config(
            user.preferences, provider_id, service_id
        )
        resource_url = str(config.get("url") or "").strip()
        if not resource_url:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                "Please save the MCP OAuth server URL before connecting",
            )

        metadata = await UserMcpOAuthService.discover(resource_url)
        client_id = await UserMcpOAuthService._ensure_client(
            db, user=user, provider_id=provider_id, metadata=metadata
        )

        now = int(time.time())
        ttl = settings.MCP_OAUTH_SESSION_TTL_SECONDS
        session_id = str(uuid.uuid4())
        poll_token = secrets.token_urlsafe(32)
        nonce = secrets.token_urlsafe(24)
        binding = secrets.token_urlsafe(24)
        verifier = secrets.token_urlsafe(64)
        state = jwt.encode(
            {
                "sub": str(user.id),
                "provider": provider_id,
                "service": service_id,
                "session_id": session_id,
                "nonce": nonce,
                "aud": STATE_AUDIENCE,
                "iat": now,
                "exp": now + ttl,
            },
            _state_secret(),
            algorithm=settings.ALGORITHM,
        )
        session_data = {
            "status": "pending",
            "provider_id": provider_id,
            "service_id": service_id,
            "user_id": user.id,
            "poll_token": poll_token,
            "nonce": nonce,
            "binding": binding,
            "code_verifier": verifier,
            "resource": resource_url,
            "token_endpoint": metadata["token_endpoint"],
            "redirect_uri": settings.MCP_OAUTH_REDIRECT_URI,
            "client_id": client_id,
            "expires_at": now + ttl,
        }
        if not await cache_manager.set(
            _session_key(session_id), session_data, expire=ttl
        ):
            raise HTTPException(
                status.HTTP_500_INTERNAL_SERVER_ERROR,
                "Failed to create MCP authorization session",
            )

        params = urlencode(
            {
                "response_type": "code",
                "client_id": client_id,
                "redirect_uri": settings.MCP_OAUTH_REDIRECT_URI,
                "scope": metadata.get("scope") or "",
                # RFC 8707 resource indicator: DingTalk requires the authorize
                # request to name the protected MCP server it grants access to.
                "resource": resource_url,
                "state": state,
                "code_challenge": _pkce_challenge(verifier),
                "code_challenge_method": "S256",
            }
        )
        return {
            "session_id": session_id,
            "poll_token": poll_token,
            "authorize_url": f"{metadata['authorization_endpoint']}?{params}",
            "expires_at": now + ttl,
            "poll_interval_seconds": POLL_INTERVAL_SECONDS,
            "binding": binding,
        }

    @staticmethod
    async def poll_session(
        db: Session,
        *,
        user: User,
        provider_id: str,
        service_id: str,
        session_id: str,
        poll_token: str,
    ) -> dict[str, Any]:
        """Report the state of an authorization session."""
        session = await UserMcpOAuthService._read_session(session_id)
        if (
            not secrets.compare_digest(str(session.get("poll_token") or ""), poll_token)
            or int(session.get("user_id") or 0) != user.id
            or str(session.get("provider_id")) != provider_id
            or str(session.get("service_id")) != service_id
        ):
            raise HTTPException(
                status.HTTP_401_UNAUTHORIZED,
                "Invalid MCP authorization polling token",
            )

        current_status = str(session.get("status") or "pending")
        if current_status == "pending":
            return {"status": "pending"}
        if current_status == "declined":
            return {"status": "declined"}
        if current_status != "success":
            return {
                "status": "failed",
                "error": str(session.get("error") or "MCP authorization failed"),
            }

        session["status"] = "claimed"
        await UserMcpOAuthService._write_session(session_id, session)
        config = user_mcp_service.get_provider_service_config(
            user.preferences, provider_id, service_id
        )
        return {
            "status": "success",
            "account": config.get("oauth_account"),
            "expires_at": config.get("oauth_expires_at"),
        }

    @staticmethod
    async def complete_callback(
        db: Session,
        *,
        code: str | None,
        state_token: str,
        provider_error: str | None = None,
        browser_binding: str | None = None,
    ) -> str:
        """Complete the authorization-code exchange after the user returns."""
        claims = UserMcpOAuthService._decode_state(state_token)
        session_id = str(claims["session_id"])
        session = await UserMcpOAuthService._read_session(session_id)
        UserMcpOAuthService._validate_browser_binding(
            session, session_id=session_id, browser_binding=browser_binding
        )
        UserMcpOAuthService._validate_callback_session(claims, session)
        if str(session.get("status")) != "pending":
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "MCP authorization session has already completed",
            )

        if provider_error:
            session.update({"status": "declined", "error": provider_error})
            await UserMcpOAuthService._write_session(session_id, session)
            return "Authorization was declined. You can close this window."
        if not code:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST, "MCP authorization code is missing"
            )

        try:
            token_payload = await UserMcpOAuthService._exchange_code(
                session=session, code=code
            )
        except (httpx.HTTPError, ValueError) as exc:
            session.update(
                {"status": "failed", "error": "MCP authorization could not complete"}
            )
            await UserMcpOAuthService._write_session(session_id, session)
            raise HTTPException(
                status.HTTP_502_BAD_GATEWAY,
                "MCP authorization could not be completed",
            ) from exc

        user = db.get(User, int(session["user_id"]))
        if not user:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "User not found")
        UserMcpOAuthService._store_tokens(user, session, token_payload)
        db.add(user)
        db.commit()
        db.refresh(user)

        session.update({"status": "success", "completed_at": int(time.time())})
        session.pop("code_verifier", None)
        await UserMcpOAuthService._write_session(session_id, session)
        return "Connected. You can close this window."

    @staticmethod
    def clear_stored_credentials(
        db: Session,
        *,
        user: User,
        provider_id: str,
        service_id: str,
    ) -> None:
        """Drop stored OAuth credentials for a provider service."""
        updated = user_mcp_service.clear_service_oauth_credentials(
            user.preferences, provider_id, service_id
        )
        preferences = user_mcp_service.dump_preferences(updated)
        # Callers can hold a user loaded in another session (request building
        # runs in a fresh session), so merge instead of add: adding a detached
        # instance would insert a duplicate user row.
        persistent = db.merge(user)
        persistent.preferences = preferences
        db.commit()
        db.refresh(persistent)
        user.preferences = persistent.preferences

    @staticmethod
    async def disconnect(
        db: Session,
        *,
        user: User,
        provider_id: str,
        service_id: str,
    ) -> None:
        """Drop stored credentials after the user disconnects a service."""
        UserMcpOAuthService.clear_stored_credentials(
            db, user=user, provider_id=provider_id, service_id=service_id
        )

    @staticmethod
    async def ensure_access_token(
        db: Session,
        *,
        user: User,
        provider_id: str,
        service_id: str,
    ) -> str:
        """Return a usable access token, refreshing it when it is close to expiry."""
        fresh = UserMcpOAuthService._usable_token(user, provider_id, service_id)
        if fresh:
            return fresh

        target = UserMcpOAuthService._refresh_target(user, provider_id, service_id)
        if not target:
            return ""
        try:
            async with httpx.AsyncClient(timeout=DISCOVERY_TIMEOUT_SECONDS) as client:
                response = await client.post(
                    target["token_endpoint"],
                    data=UserMcpOAuthService._refresh_body(target),
                )
                response.raise_for_status()
                payload = response.json()
            UserMcpOAuthService._require_token_payload(payload)
        except httpx.HTTPStatusError as exc:
            UserMcpOAuthService._note_refresh_failure(
                db,
                user=user,
                provider_id=provider_id,
                service_id=service_id,
                reason=f"HTTP {exc.response.status_code}",
                response=exc.response,
            )
            return ""
        except (httpx.HTTPError, ValueError) as exc:
            UserMcpOAuthService._note_refresh_failure(
                db,
                user=user,
                provider_id=provider_id,
                service_id=service_id,
                reason=type(exc).__name__,
            )
            return ""

        return UserMcpOAuthService._store_tokens_from_payload(
            db,
            user=user,
            provider_id=provider_id,
            service_id=service_id,
            payload=payload,
            fallback_refresh_token=target["refresh_token"],
        )

    @staticmethod
    def ensure_access_token_sync(
        db: Session,
        *,
        user: User,
        provider_id: str,
        service_id: str,
    ) -> str:
        """Synchronous variant used while assembling an execution request."""
        fresh = UserMcpOAuthService._usable_token(user, provider_id, service_id)
        if fresh:
            return fresh

        target = UserMcpOAuthService._refresh_target(user, provider_id, service_id)
        if not target:
            return ""
        try:
            with httpx.Client(timeout=DISCOVERY_TIMEOUT_SECONDS) as client:
                response = client.post(
                    target["token_endpoint"],
                    data=UserMcpOAuthService._refresh_body(target),
                )
                response.raise_for_status()
                payload = response.json()
            UserMcpOAuthService._require_token_payload(payload)
        except httpx.HTTPStatusError as exc:
            UserMcpOAuthService._note_refresh_failure(
                db,
                user=user,
                provider_id=provider_id,
                service_id=service_id,
                reason=f"HTTP {exc.response.status_code}",
                response=exc.response,
            )
            return ""
        except (httpx.HTTPError, ValueError) as exc:
            UserMcpOAuthService._note_refresh_failure(
                db,
                user=user,
                provider_id=provider_id,
                service_id=service_id,
                reason=type(exc).__name__,
            )
            return ""

        return UserMcpOAuthService._store_tokens_from_payload(
            db,
            user=user,
            provider_id=provider_id,
            service_id=service_id,
            payload=payload,
            fallback_refresh_token=target["refresh_token"],
        )

    @staticmethod
    def _validate_browser_binding(
        session: dict[str, Any],
        *,
        session_id: str,
        browser_binding: str | None,
    ) -> None:
        """Require the completing browser to be the one that started the flow."""
        expected = str(session.get("binding") or "")
        cookie_session_id, _, provided = (browser_binding or "").partition(".")
        if (
            not expected
            or not provided
            or not secrets.compare_digest(session_id, cookie_session_id)
            or not secrets.compare_digest(expected, provided)
        ):
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                "MCP OAuth authorization must be completed in the browser "
                "that started it",
            )

    @staticmethod
    async def provider_service_headers(
        db: Session,
        *,
        user: User,
        provider_id: str,
        service_id: str,
    ) -> dict[str, str]:
        """Return request headers for an OAuth-authorized provider MCP service."""
        if (
            user_mcp_service.get_service_auth_mode(
                getattr(user, "preferences", None), provider_id, service_id
            )
            != MCP_AUTH_MODE_OAUTH
        ):
            return {}
        config = user_mcp_service.get_provider_service_config(
            getattr(user, "preferences", None), provider_id, service_id
        )
        if not is_secure_mcp_url(str(config.get("url") or "")):
            logger.warning(
                "[MCP-OAUTH] Refusing to send an OAuth token over an insecure "
                "transport for %s/%s",
                provider_id,
                service_id,
            )
            return {}
        access_token = await UserMcpOAuthService.ensure_access_token(
            db, user=user, provider_id=provider_id, service_id=service_id
        )
        if not access_token:
            logger.warning(
                "[MCP-OAUTH] %s/%s is authorized with OAuth but has no usable "
                "access token; the provider request needs reauthorization",
                provider_id,
                service_id,
            )
            raise ValueError(
                f"{provider_id} MCP authorization is no longer valid; "
                "reconnect the service and try again"
            )
        return {"Authorization": f"Bearer {access_token}"}

    @staticmethod
    def _usable_token(user: User, provider_id: str, service_id: str) -> str:
        """Return the stored access token while it is still safe to use."""
        credentials = user_mcp_service.get_service_oauth_credentials(
            user.preferences, provider_id, service_id
        )
        access_token = str(credentials.get("access_token") or "")
        expires_at = int(credentials.get("expires_at") or 0)
        if access_token and (
            expires_at == 0 or expires_at - REFRESH_SKEW_SECONDS > int(time.time())
        ):
            return access_token
        return ""

    @staticmethod
    def _refresh_target(
        user: User, provider_id: str, service_id: str
    ) -> dict[str, str] | None:
        """Return the refresh inputs, or None when a refresh is impossible."""
        credentials = user_mcp_service.get_service_oauth_credentials(
            user.preferences, provider_id, service_id
        )
        refresh_token = str(credentials.get("refresh_token") or "")
        client = user_mcp_service.get_provider_oauth_client(
            user.preferences, provider_id
        )
        token_endpoint = str(client.get("token_endpoint") or "")
        client_id = str(client.get("client_id") or "")
        if not refresh_token or not token_endpoint or not client_id:
            return None
        return {
            "refresh_token": refresh_token,
            "token_endpoint": token_endpoint,
            "client_id": client_id,
        }

    @staticmethod
    def _refresh_body(target: dict[str, str]) -> dict[str, str]:
        return {
            "grant_type": "refresh_token",
            "client_id": target["client_id"],
            "refresh_token": target["refresh_token"],
        }

    @staticmethod
    def _response_oauth_error(response: httpx.Response | None) -> str:
        """Return the OAuth error code reported by a failed token response."""
        if response is None:
            return ""
        try:
            payload = response.json()
        except ValueError:
            return ""
        if not isinstance(payload, dict):
            return ""
        return str(payload.get("error") or "").strip()

    @staticmethod
    def _note_refresh_failure(
        db: Session,
        *,
        user: User,
        provider_id: str,
        service_id: str,
        reason: str,
        response: httpx.Response | None = None,
    ) -> None:
        """Log a failed refresh and drop only the grants the provider rejected."""
        error = UserMcpOAuthService._response_oauth_error(response)
        logger.warning(
            "[MCP-OAUTH] Token refresh failed for %s/%s (%s) error=%s",
            provider_id,
            service_id,
            reason,
            error or "unreported",
        )
        if error != INVALID_GRANT_ERROR:
            return
        UserMcpOAuthService.clear_stored_credentials(
            db, user=user, provider_id=provider_id, service_id=service_id
        )
        logger.info(
            "[MCP-OAUTH] Cleared the rejected grant for %s/%s; the service "
            "must be authorized again",
            provider_id,
            service_id,
        )

    @staticmethod
    def _require_token_payload(payload: Any) -> None:
        if (
            not isinstance(payload, dict)
            or payload.get("error")
            or not payload.get("access_token")
        ):
            raise ValueError("MCP OAuth token refresh failed")

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------

    @staticmethod
    async def _resource_metadata_url(
        client: httpx.AsyncClient, resource_url: str
    ) -> str:
        """Resolve the protected-resource metadata document for an MCP URL."""
        try:
            response = await client.get(
                resource_url,
                headers={"Accept": "application/json, text/event-stream"},
            )
        except httpx.HTTPError as exc:
            raise HTTPException(
                status.HTTP_502_BAD_GATEWAY, "MCP OAuth discovery failed"
            ) from exc

        header = response.headers.get("www-authenticate", "")
        marker = 'resource_metadata="'
        if marker in header:
            start = header.index(marker) + len(marker)
            end = header.find('"', start)
            if end > start:
                return _require_secure_url(
                    header[start:end], field="resource metadata URL"
                )

        parsed = urlsplit(resource_url)
        origin = urlunsplit((parsed.scheme, parsed.netloc, "", "", ""))
        return f"{origin}/.well-known/oauth-protected-resource{parsed.path}"

    @staticmethod
    async def _get_json(client: httpx.AsyncClient, url: str) -> dict[str, Any]:
        try:
            response = await client.get(url)
            response.raise_for_status()
            payload = response.json()
        except (httpx.HTTPError, ValueError) as exc:
            raise HTTPException(
                status.HTTP_502_BAD_GATEWAY, "MCP OAuth discovery failed"
            ) from exc
        if not isinstance(payload, dict):
            raise HTTPException(
                status.HTTP_502_BAD_GATEWAY, "MCP OAuth discovery returned no metadata"
            )
        return payload

    @staticmethod
    async def _ensure_client(
        db: Session,
        *,
        user: User,
        provider_id: str,
        metadata: dict[str, Any],
    ) -> str:
        """Reuse the cached client registration or register a public client."""
        cached = user_mcp_service.get_provider_oauth_client(
            user.preferences, provider_id
        )
        if (
            cached.get("client_id")
            and cached.get("issuer") == metadata["issuer"]
            and cached.get("redirect_uri") == settings.MCP_OAUTH_REDIRECT_URI
        ):
            return str(cached["client_id"])

        registration_endpoint = metadata.get("registration_endpoint")
        if not registration_endpoint:
            raise HTTPException(
                status.HTTP_502_BAD_GATEWAY,
                "MCP OAuth server does not support client registration",
            )

        body = {
            "client_name": "Wegent",
            "redirect_uris": [settings.MCP_OAUTH_REDIRECT_URI],
            "grant_types": ["authorization_code", "refresh_token"],
            "response_types": ["code"],
            "token_endpoint_auth_method": "none",
        }
        if metadata.get("scope"):
            body["scope"] = metadata["scope"]

        try:
            async with httpx.AsyncClient(timeout=DISCOVERY_TIMEOUT_SECONDS) as client:
                response = await client.post(registration_endpoint, json=body)
                response.raise_for_status()
                payload = response.json()
        except (httpx.HTTPError, ValueError) as exc:
            raise HTTPException(
                status.HTTP_502_BAD_GATEWAY, "MCP OAuth client registration failed"
            ) from exc

        client_id = str((payload or {}).get("client_id") or "")
        if not client_id:
            raise HTTPException(
                status.HTTP_502_BAD_GATEWAY, "MCP OAuth client registration failed"
            )

        updated = user_mcp_service.set_provider_oauth_client(
            user.preferences,
            provider_id,
            {
                "issuer": metadata["issuer"],
                "authorization_endpoint": metadata["authorization_endpoint"],
                "token_endpoint": metadata["token_endpoint"],
                "registration_endpoint": registration_endpoint,
                "redirect_uri": settings.MCP_OAUTH_REDIRECT_URI,
                "client_id": client_id,
                "issued_at": int(time.time()),
            },
        )
        user.preferences = user_mcp_service.dump_preferences(updated)
        db.add(user)
        db.commit()
        db.refresh(user)
        return client_id

    @staticmethod
    async def _exchange_code(*, session: dict[str, Any], code: str) -> dict[str, Any]:
        async with httpx.AsyncClient(timeout=DISCOVERY_TIMEOUT_SECONDS) as client:
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
        if not isinstance(payload, dict) or payload.get("error"):
            raise ValueError("MCP OAuth token exchange failed")
        if not payload.get("access_token"):
            raise ValueError("MCP OAuth token exchange returned no access token")
        return payload

    @staticmethod
    def _expires_at(payload: dict[str, Any]) -> int:
        expires_in = payload.get("expires_in")
        try:
            seconds = int(expires_in)
        except (TypeError, ValueError):
            seconds = 0
        return int(time.time()) + seconds if seconds > 0 else 0

    @staticmethod
    def _store_tokens(
        user: User, session: dict[str, Any], payload: dict[str, Any]
    ) -> None:
        updated = user_mcp_service.save_service_oauth_credentials(
            user.preferences,
            str(session["provider_id"]),
            str(session["service_id"]),
            access_token=str(payload.get("access_token") or ""),
            refresh_token=str(payload.get("refresh_token") or ""),
            expires_at=UserMcpOAuthService._expires_at(payload),
            scope=str(payload.get("scope") or ""),
        )
        user.preferences = user_mcp_service.dump_preferences(updated)

    @staticmethod
    def _store_tokens_from_payload(
        db: Session,
        *,
        user: User,
        provider_id: str,
        service_id: str,
        payload: dict[str, Any],
        fallback_refresh_token: str,
    ) -> str:
        access_token = str(payload.get("access_token") or "")
        updated = user_mcp_service.save_service_oauth_credentials(
            user.preferences,
            provider_id,
            service_id,
            access_token=access_token,
            refresh_token=str(payload.get("refresh_token") or fallback_refresh_token),
            expires_at=UserMcpOAuthService._expires_at(payload),
            scope=str(payload.get("scope") or ""),
        )
        preferences = user_mcp_service.dump_preferences(updated)
        # Callers can hold a user loaded in another session (request building
        # runs in a fresh session), so merge instead of add: adding a detached
        # instance would insert a duplicate user row.
        persistent = db.merge(user)
        persistent.preferences = preferences
        db.commit()
        db.refresh(persistent)
        user.preferences = persistent.preferences
        return access_token

    @staticmethod
    def _decode_state(state_token: str) -> dict[str, Any]:
        try:
            return jwt.decode(
                state_token,
                _state_secret(),
                algorithms=[settings.ALGORITHM],
                audience=STATE_AUDIENCE,
            )
        except JWTError as exc:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                "Invalid or expired MCP OAuth state",
            ) from exc

    @staticmethod
    def _validate_callback_session(
        claims: dict[str, Any], session: dict[str, Any]
    ) -> None:
        if (
            str(claims.get("provider")) != str(session.get("provider_id"))
            or str(claims.get("service")) != str(session.get("service_id"))
            or int(claims.get("sub") or 0) != int(session.get("user_id") or 0)
            or not secrets.compare_digest(
                str(claims.get("nonce") or ""), str(session.get("nonce") or "")
            )
        ):
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                "MCP OAuth state does not match the session",
            )

    @staticmethod
    async def _read_session(session_id: str) -> dict[str, Any]:
        try:
            uuid.UUID(session_id, version=4)
        except ValueError as exc:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST, "Invalid MCP authorization session"
            ) from exc
        session = await cache_manager.get(_session_key(session_id))
        if not isinstance(session, dict):
            raise HTTPException(
                status.HTTP_404_NOT_FOUND,
                "MCP authorization session expired or was not found",
            )
        return session

    @staticmethod
    async def _write_session(session_id: str, session: dict[str, Any]) -> None:
        remaining = max(1, int(session.get("expires_at") or 0) - int(time.time()))
        if not await cache_manager.set(
            _session_key(session_id), session, expire=remaining
        ):
            raise HTTPException(
                status.HTTP_500_INTERNAL_SERVER_ERROR,
                "Failed to update MCP authorization session",
            )


user_mcp_oauth_service = UserMcpOAuthService()
