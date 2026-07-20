# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Connector app catalog, authorization, and credential services."""

from __future__ import annotations

import base64
import hashlib
import json
import secrets
from datetime import datetime, timedelta, timezone
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

import httpx
from fastapi import HTTPException, status
from sqlalchemy import func
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models.connector import (
    ConnectorApp,
    ConnectorConnection,
    ConnectorOAuthSession,
)
from app.models.user import User
from app.schemas.connector import (
    ConnectorAppAdminResponse,
    ConnectorAppResponse,
    ConnectorAppUpdate,
    ConnectorAppWrite,
    ConnectorConnectionResponse,
)
from shared.telemetry.decorators import trace_async
from shared.utils.crypto import (
    decrypt_sensitive_data_with_embedded_iv,
    encrypt_sensitive_data_with_embedded_iv,
)

OAUTH_SESSION_TTL_MINUTES = 10


def _encrypt_json(value: dict[str, str]) -> str | None:
    return encrypt_sensitive_data_with_embedded_iv(json.dumps(value)) if value else None


def _decrypt_json(value: str | None) -> dict[str, str]:
    if not value:
        return {}
    decrypted = decrypt_sensitive_data_with_embedded_iv(value)
    parsed = json.loads(decrypted or "{}")
    if not isinstance(parsed, dict):
        return {}
    return {
        key: item
        for key, item in parsed.items()
        if isinstance(key, str) and isinstance(item, str)
    }


def _utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _token_expiry(expires_in: object) -> datetime | None:
    try:
        seconds = int(expires_in) if expires_in is not None else 0
    except (TypeError, ValueError):
        return None
    if seconds <= 0:
        return None
    return _utcnow() + timedelta(seconds=seconds)


class ConnectorAppService:
    """Own connector definitions and user-specific connection state."""

    @staticmethod
    def create_app(
        db: Session, payload: ConnectorAppWrite, admin: User
    ) -> ConnectorApp:
        if db.query(ConnectorApp).filter(ConnectorApp.slug == payload.slug).first():
            raise HTTPException(
                status.HTTP_409_CONFLICT, "Connector slug already exists"
            )
        values = payload.model_dump(exclude={"oauth_client_secret", "provider_headers"})
        app = ConnectorApp(
            **values,
            oauth_client_secret_encrypted=(
                encrypt_sensitive_data_with_embedded_iv(payload.oauth_client_secret)
                if payload.auth_type == "oauth2"
                and payload.oauth_client_auth_method != "none"
                and payload.oauth_client_secret
                else None
            ),
            provider_headers_encrypted=_encrypt_json(payload.provider_headers),
            created_by=admin.id,
        )
        db.add(app)
        try:
            db.commit()
        except IntegrityError as exc:
            db.rollback()
            raise HTTPException(
                status.HTTP_409_CONFLICT, "Connector slug already exists"
            ) from exc
        db.refresh(app)
        return app

    @staticmethod
    def update_app(
        db: Session, app: ConnectorApp, payload: ConnectorAppUpdate
    ) -> ConnectorApp:
        security_fields = {
            "enabled",
            "visibility",
            "allowed_roles",
            "auth_type",
            "mcp_url",
            "oauth_authorization_url",
            "oauth_token_url",
            "oauth_client_id",
            "oauth_client_auth_method",
            "oauth_scopes",
        }
        invalidate_connections = any(
            field in payload.model_fields_set
            and getattr(payload, field) != getattr(app, field)
            for field in security_fields
        )
        invalidate_connections = invalidate_connections or bool(
            payload.oauth_client_secret
            or (payload.clear_oauth_client_secret and app.oauth_client_secret_encrypted)
        )
        values = payload.model_dump(
            exclude_unset=True,
            exclude={
                "oauth_client_secret",
                "clear_oauth_client_secret",
                "provider_headers",
                "clear_provider_headers",
            },
        )
        secret_configured = bool(app.oauth_client_secret_encrypted)
        if payload.oauth_client_secret is not None:
            secret_configured = True
        elif payload.clear_oauth_client_secret:
            secret_configured = False
        ConnectorAppService._validate_configuration(
            visibility=values.get("visibility", app.visibility),
            allowed_roles=values.get("allowed_roles", app.allowed_roles),
            auth_type=values.get("auth_type", app.auth_type),
            oauth_authorization_url=values.get(
                "oauth_authorization_url", app.oauth_authorization_url
            ),
            oauth_token_url=values.get("oauth_token_url", app.oauth_token_url),
            oauth_client_id=values.get("oauth_client_id", app.oauth_client_id),
            oauth_client_auth_method=values.get(
                "oauth_client_auth_method", app.oauth_client_auth_method
            ),
            oauth_client_secret_configured=secret_configured,
        )
        for key, value in values.items():
            setattr(app, key, value)
        if payload.oauth_client_secret is not None:
            app.oauth_client_secret_encrypted = encrypt_sensitive_data_with_embedded_iv(
                payload.oauth_client_secret
            )
        elif payload.clear_oauth_client_secret:
            app.oauth_client_secret_encrypted = None
        if app.auth_type != "oauth2" or app.oauth_client_auth_method == "none":
            app.oauth_client_secret_encrypted = None
        if payload.provider_headers is not None:
            app.provider_headers_encrypted = _encrypt_json(payload.provider_headers)
        elif payload.clear_provider_headers:
            app.provider_headers_encrypted = None
        if invalidate_connections:
            db.query(ConnectorConnection).filter(
                ConnectorConnection.app_id == app.id
            ).delete(synchronize_session=False)
            db.query(ConnectorOAuthSession).filter(
                ConnectorOAuthSession.app_id == app.id,
                ConnectorOAuthSession.consumed_at.is_(None),
            ).delete(synchronize_session=False)
        db.commit()
        db.refresh(app)
        return app

    @staticmethod
    def _validate_configuration(
        *,
        visibility: str,
        allowed_roles: list[str] | None,
        auth_type: str,
        oauth_authorization_url: str | None,
        oauth_token_url: str | None,
        oauth_client_id: str | None,
        oauth_client_auth_method: str,
        oauth_client_secret_configured: bool,
    ) -> None:
        if visibility == "roles" and not allowed_roles:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Roles required")
        if auth_type == "oauth2" and not all(
            (oauth_authorization_url, oauth_token_url, oauth_client_id)
        ):
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                "OAuth URLs and client ID are required",
            )
        if (
            auth_type == "oauth2"
            and oauth_client_auth_method != "none"
            and not oauth_client_secret_configured
        ):
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                "OAuth client secret is required for confidential clients",
            )

    @staticmethod
    def get_app(db: Session, app_id: int) -> ConnectorApp:
        app = db.query(ConnectorApp).filter(ConnectorApp.id == app_id).first()
        if not app:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Connector app not found")
        return app

    @staticmethod
    def admin_response(db: Session, app: ConnectorApp) -> ConnectorAppAdminResponse:
        count = (
            db.query(func.count(ConnectorConnection.id))
            .filter(ConnectorConnection.app_id == app.id)
            .scalar()
            or 0
        )
        provider_headers = _decrypt_json(app.provider_headers_encrypted)
        return ConnectorAppAdminResponse(
            id=app.id,
            slug=app.slug,
            name=app.name,
            description=app.description,
            icon_url=app.icon_url,
            enabled=app.enabled,
            visibility=app.visibility,
            allowed_roles=list(app.allowed_roles or []),
            auth_type=app.auth_type,
            transport=app.transport,
            mcp_url=app.mcp_url,
            oauth_authorization_url=app.oauth_authorization_url,
            oauth_token_url=app.oauth_token_url,
            oauth_client_id=app.oauth_client_id,
            oauth_client_auth_method=app.oauth_client_auth_method,
            oauth_client_secret_configured=bool(app.oauth_client_secret_encrypted),
            oauth_scopes=list(app.oauth_scopes or []),
            provider_header_names=sorted(provider_headers),
            provider_headers_configured=bool(provider_headers),
            tool_allowlist=list(app.tool_allowlist or []),
            connection_count=count,
            created_at=app.created_at,
            updated_at=app.updated_at,
        )

    @staticmethod
    def list_visible_apps(db: Session, user: User) -> list[ConnectorApp]:
        apps = (
            db.query(ConnectorApp)
            .filter(ConnectorApp.enabled.is_(True))
            .order_by(ConnectorApp.name, ConnectorApp.id)
            .all()
        )
        return [
            app
            for app in apps
            if app.visibility == "all" or user.role in (app.allowed_roles or [])
        ]

    @staticmethod
    def connection(
        db: Session, user_id: int, app_id: int
    ) -> ConnectorConnection | None:
        return (
            db.query(ConnectorConnection)
            .filter(
                ConnectorConnection.user_id == user_id,
                ConnectorConnection.app_id == app_id,
            )
            .first()
        )

    @staticmethod
    def user_response(
        db: Session, app: ConnectorApp, user: User
    ) -> ConnectorAppResponse:
        connection = ConnectorAppService.connection(db, user.id, app.id)
        connection_status = (
            connection.status
            if connection
            else "connected" if app.auth_type == "none" else "disconnected"
        )
        if (
            connection
            and connection.expires_at
            and connection.expires_at <= _utcnow()
            and not connection.refresh_token_encrypted
        ):
            connection_status = "expired"
        return ConnectorAppResponse(
            id=app.id,
            slug=app.slug,
            name=app.name,
            description=app.description,
            icon_url=app.icon_url,
            auth_type=app.auth_type,
            connection=ConnectorConnectionResponse(
                status=connection_status,
                external_account_name=(
                    connection.external_account_name if connection else None
                ),
                granted_scopes=(
                    list(connection.granted_scopes or []) if connection else []
                ),
                expires_at=connection.expires_at if connection else None,
            ),
        )

    @staticmethod
    def connect_without_oauth(
        db: Session,
        app: ConnectorApp,
        user: User,
        *,
        bearer_token: str | None = None,
        account_name: str | None = None,
    ) -> ConnectorConnection:
        if app.auth_type == "bearer" and not bearer_token:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Token required")
        connection = ConnectorAppService.connection(db, user.id, app.id)
        if not connection:
            connection = ConnectorConnection(user_id=user.id, app_id=app.id)
            db.add(connection)
        connection.status = "connected"
        connection.external_account_name = account_name
        connection.access_token_encrypted = (
            encrypt_sensitive_data_with_embedded_iv(bearer_token)
            if bearer_token
            else None
        )
        connection.refresh_token_encrypted = None
        connection.token_type = "Bearer" if bearer_token else None
        connection.granted_scopes = []
        connection.expires_at = None
        db.commit()
        db.refresh(connection)
        return connection

    @staticmethod
    def disconnect(db: Session, app: ConnectorApp, user: User) -> None:
        connection = ConnectorAppService.connection(db, user.id, app.id)
        if connection:
            db.delete(connection)
        deleted_sessions = (
            db.query(ConnectorOAuthSession)
            .filter(
                ConnectorOAuthSession.user_id == user.id,
                ConnectorOAuthSession.app_id == app.id,
                ConnectorOAuthSession.consumed_at.is_(None),
            )
            .delete(synchronize_session=False)
        )
        if connection or deleted_sessions:
            db.commit()

    @staticmethod
    def disable_app(db: Session, app: ConnectorApp) -> None:
        """Disable an app and revoke every stored user authorization."""
        app.enabled = False
        db.query(ConnectorConnection).filter(
            ConnectorConnection.app_id == app.id
        ).delete(synchronize_session=False)
        db.query(ConnectorOAuthSession).filter(
            ConnectorOAuthSession.app_id == app.id
        ).delete(synchronize_session=False)
        db.commit()

    @staticmethod
    def begin_oauth(
        db: Session, app: ConnectorApp, user: User, callback_url: str
    ) -> str:
        if app.auth_type != "oauth2":
            raise HTTPException(status.HTTP_409_CONFLICT, "App does not use OAuth")
        state = secrets.token_urlsafe(32)
        verifier = secrets.token_urlsafe(64)
        challenge = (
            base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest())
            .decode()
            .rstrip("=")
        )
        connection = ConnectorAppService.connection(db, user.id, app.id)
        if not connection:
            connection = ConnectorConnection(user_id=user.id, app_id=app.id)
            db.add(connection)
        connection.status = "pending"
        db.query(ConnectorOAuthSession).filter(
            ConnectorOAuthSession.expires_at <= _utcnow()
        ).delete(synchronize_session=False)
        db.query(ConnectorOAuthSession).filter(
            ConnectorOAuthSession.user_id == user.id,
            ConnectorOAuthSession.app_id == app.id,
            ConnectorOAuthSession.consumed_at.is_(None),
        ).delete(synchronize_session=False)
        db.add(
            ConnectorOAuthSession(
                state_hash=hashlib.sha256(state.encode()).hexdigest(),
                user_id=user.id,
                app_id=app.id,
                redirect_uri=callback_url,
                code_verifier_encrypted=encrypt_sensitive_data_with_embedded_iv(
                    verifier
                ),
                expires_at=_utcnow() + timedelta(minutes=OAUTH_SESSION_TTL_MINUTES),
            )
        )
        db.commit()
        authorization_url = urlsplit(app.oauth_authorization_url)
        query = urlencode(
            {
                **dict(parse_qsl(authorization_url.query, keep_blank_values=True)),
                "response_type": "code",
                "client_id": app.oauth_client_id,
                "redirect_uri": callback_url,
                "scope": " ".join(app.oauth_scopes or []),
                "state": state,
                "code_challenge": challenge,
                "code_challenge_method": "S256",
            }
        )
        return urlunsplit(authorization_url._replace(query=query))

    @staticmethod
    def fail_oauth(db: Session, *, state: str) -> None:
        state_hash = hashlib.sha256(state.encode()).hexdigest()
        session = (
            db.query(ConnectorOAuthSession)
            .filter(ConnectorOAuthSession.state_hash == state_hash)
            .with_for_update()
            .first()
        )
        if not session or session.consumed_at or session.expires_at <= _utcnow():
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "OAuth session is invalid")
        connection = ConnectorAppService.connection(db, session.user_id, session.app_id)
        if connection:
            connection.status = "error"
        session.consumed_at = _utcnow()
        db.commit()

    @staticmethod
    @trace_async("connector.oauth.complete", "backend.connector")
    async def complete_oauth(
        db: Session, *, state: str, code: str
    ) -> ConnectorConnection:
        state_hash = hashlib.sha256(state.encode()).hexdigest()
        session = (
            db.query(ConnectorOAuthSession)
            .filter(ConnectorOAuthSession.state_hash == state_hash)
            .with_for_update()
            .first()
        )
        if not session or session.consumed_at or session.expires_at <= _utcnow():
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "OAuth session is invalid")
        app = ConnectorAppService.get_app(db, session.app_id)
        user = (
            db.query(User)
            .filter(User.id == session.user_id, User.is_active.is_(True))
            .first()
        )
        visible_app_ids = (
            {item.id for item in ConnectorAppService.list_visible_apps(db, user)}
            if user
            else set()
        )
        if app.id not in visible_app_ids:
            session.consumed_at = _utcnow()
            db.commit()
            raise HTTPException(
                status.HTTP_403_FORBIDDEN,
                "Connector authorization is no longer allowed",
            )
        secret = (
            decrypt_sensitive_data_with_embedded_iv(
                app.oauth_client_secret_encrypted or ""
            )
            or ""
        )
        verifier = (
            decrypt_sensitive_data_with_embedded_iv(session.code_verifier_encrypted)
            or ""
        )
        data = {
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": session.redirect_uri,
            "client_id": app.oauth_client_id,
            "code_verifier": verifier,
        }
        request_auth = None
        if secret and app.oauth_client_auth_method == "client_secret_basic":
            request_auth = (app.oauth_client_id, secret)
        elif secret and app.oauth_client_auth_method == "client_secret_post":
            data["client_secret"] = secret
        session.consumed_at = _utcnow()
        db.commit()
        try:
            async with httpx.AsyncClient(timeout=30) as client:
                response = await client.post(
                    app.oauth_token_url, data=data, auth=request_auth
                )
        except httpx.HTTPError as exc:
            ConnectorAppService._set_oauth_connection_error(db, session)
            raise HTTPException(
                status.HTTP_502_BAD_GATEWAY, "OAuth token exchange failed"
            ) from exc
        if response.is_error:
            ConnectorAppService._set_oauth_connection_error(db, session)
            raise HTTPException(
                status.HTTP_502_BAD_GATEWAY, "OAuth token exchange failed"
            )
        try:
            token = response.json()
        except ValueError as exc:
            ConnectorAppService._set_oauth_connection_error(db, session)
            raise HTTPException(
                status.HTTP_502_BAD_GATEWAY, "OAuth token response is invalid"
            ) from exc
        if not isinstance(token, dict):
            ConnectorAppService._set_oauth_connection_error(db, session)
            raise HTTPException(
                status.HTTP_502_BAD_GATEWAY, "OAuth token response is invalid"
            )
        access_token = token.get("access_token")
        if not isinstance(access_token, str) or not access_token:
            ConnectorAppService._set_oauth_connection_error(db, session)
            raise HTTPException(status.HTTP_502_BAD_GATEWAY, "OAuth token is missing")
        connection = ConnectorAppService.connection(db, session.user_id, app.id)
        if not connection:
            connection = ConnectorConnection(user_id=session.user_id, app_id=app.id)
            db.add(connection)
        connection.status = "connected"
        connection.access_token_encrypted = encrypt_sensitive_data_with_embedded_iv(
            access_token
        )
        refresh_token = token.get("refresh_token")
        connection.refresh_token_encrypted = (
            encrypt_sensitive_data_with_embedded_iv(refresh_token)
            if isinstance(refresh_token, str) and refresh_token
            else None
        )
        connection.token_type = str(token.get("token_type") or "Bearer")
        raw_scope = token.get("scope")
        connection.granted_scopes = (
            raw_scope.split()
            if isinstance(raw_scope, str)
            else list(app.oauth_scopes or [])
        )
        connection.expires_at = _token_expiry(token.get("expires_in"))
        db.commit()
        db.refresh(connection)
        return connection

    @staticmethod
    def _set_oauth_connection_error(
        db: Session, session: ConnectorOAuthSession
    ) -> None:
        connection = ConnectorAppService.connection(db, session.user_id, session.app_id)
        if connection:
            connection.status = "error"
        db.commit()


connector_app_service = ConnectorAppService()
