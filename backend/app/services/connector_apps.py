# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Connector app catalog services backed by the generic kinds table."""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime
from typing import Any

import httpx
from fastapi import HTTPException, status
from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified

from app.models.kind import Kind
from app.models.user import User
from app.schemas.connector import (
    ConnectorAppAdminResponse,
    ConnectorAppResponse,
    ConnectorAppUpdate,
    ConnectorAppWrite,
    ConnectorConnectionResponse,
    ConnectorHttpToolDefinition,
)
from app.services.connector_connections import (
    CONNECTOR_CONNECTION_KIND,
    CONNECTOR_CONNECTION_NAMESPACE,
    connector_connection_service,
)
from shared.utils.crypto import decrypt_sensitive_data, encrypt_sensitive_data

CONNECTOR_APP_KIND = "ConnectorApp"
CONNECTOR_APP_NAMESPACE = "system"
CONNECTOR_APP_USER_ID = 0
# Upstream gateways (for example DingTalk) resolve to a pool of edge nodes and
# one node can briefly serve an invalid certificate while it is redeployed.
# httpcore only replays connection establishment, so retrying cannot duplicate
# a tool call that already reached the upstream.
CONNECTOR_CONNECT_RETRIES = 2


def create_connector_http_client(
    headers: dict[str, str] | None = None,
    timeout: httpx.Timeout | None = None,
    auth: httpx.Auth | None = None,
    follow_redirects: bool = True,
) -> httpx.AsyncClient:
    """Create an HTTP client for connector traffic.

    trust_env=False keeps connector calls off ambient HTTP(S)_PROXY
    settings: connector endpoints are configured explicitly and ambient
    proxies make upstream connections fail non-deterministically.

    ``retries`` only covers DNS/TCP/TLS establishment. Requests that were
    already written are never replayed, which keeps tool calls idempotent.
    """
    return httpx.AsyncClient(
        headers=headers,
        timeout=timeout,
        auth=auth,
        follow_redirects=follow_redirects,
        trust_env=False,
        transport=httpx.AsyncHTTPTransport(retries=CONNECTOR_CONNECT_RETRIES),
    )


@dataclass
class ConnectorApp:
    """Runtime view of a connector app stored as a Kind resource."""

    id: int
    slug: str
    name: str
    description: str
    icon_url: str | None
    enabled: bool
    visibility: str
    allowed_roles: list[str]
    auth_type: str
    oauth_scope: str | None
    oauth_client_encrypted: str | None
    transport: str
    mcp_url: str
    tool_loading_mode: str
    keywords: list[str]
    provider_headers_encrypted: str | None
    forward_user_context_headers: bool
    tool_allowlist: list[str]
    http_tools: list[dict[str, Any]]
    created_by: int | None
    created_at: datetime
    updated_at: datetime
    row: Kind


def _encrypt_json(value: dict[str, str]) -> str | None:
    return encrypt_sensitive_data(json.dumps(value)) if value else None


def _decrypt_json(value: str | None) -> dict[str, str]:
    if not value:
        return {}
    decrypted = decrypt_sensitive_data(value)
    try:
        parsed = json.loads(decrypted or "{}")
    except ValueError:
        return {}
    if not isinstance(parsed, dict):
        return {}
    return {
        key: item
        for key, item in parsed.items()
        if isinstance(key, str) and isinstance(item, str)
    }


def _metadata(slug: str, display_name: str | None = None) -> dict[str, Any]:
    data: dict[str, Any] = {
        "name": slug,
        "namespace": CONNECTOR_APP_NAMESPACE,
    }
    if display_name:
        data["displayName"] = display_name
    return data


class ConnectorAppService:
    """Own administrator-managed connector definitions."""

    @staticmethod
    def create_app(
        db: Session, payload: ConnectorAppWrite, admin: User
    ) -> ConnectorApp:
        if ConnectorAppService._find_row_by_slug(db, payload.slug):
            raise HTTPException(
                status.HTTP_409_CONFLICT, "Connector slug already exists"
            )
        ConnectorAppService._validate_configuration(
            visibility=payload.visibility,
            allowed_roles=payload.allowed_roles,
            transport=payload.transport,
            http_tools=payload.http_tools,
            tool_allowlist=payload.tool_allowlist,
        )
        row = Kind(
            user_id=CONNECTOR_APP_USER_ID,
            kind=CONNECTOR_APP_KIND,
            name=payload.slug,
            namespace=CONNECTOR_APP_NAMESPACE,
            json=ConnectorAppService._payload(
                payload=payload,
                created_by=admin.id,
            ),
            is_active=True,
        )
        db.add(row)
        db.commit()
        db.refresh(row)
        return ConnectorAppService._row_to_app(row)

    @staticmethod
    def update_app(
        db: Session, app: ConnectorApp, payload: ConnectorAppUpdate
    ) -> ConnectorApp:
        current = ConnectorAppService._spec(app.row)

        values = payload.model_dump(
            mode="json",
            by_alias=False,
            exclude_unset=True,
            exclude={
                "provider_headers",
                "clear_provider_headers",
                "clear_oauth_client",
            },
        )
        for key, value in values.items():
            current[ConnectorAppService._spec_key(key)] = value

        if payload.clear_oauth_client:
            current.pop("oauthClientEncrypted", None)

        if payload.provider_headers is not None:
            current["providerHeadersEncrypted"] = _encrypt_json(
                payload.provider_headers
            )
        elif payload.clear_provider_headers:
            current.pop("providerHeadersEncrypted", None)

        ConnectorAppService._validate_configuration(
            visibility=str(current.get("visibility") or "all"),
            allowed_roles=list(current.get("allowedRoles") or []),
            transport=str(current.get("transport") or "streamable-http"),
            http_tools=list(current.get("httpTools") or []),
            tool_allowlist=list(current.get("toolAllowlist") or []),
        )
        data = dict(app.row.json or {})
        data["spec"] = current
        display_name = str(current.get("name") or app.slug)
        data["metadata"] = _metadata(app.slug, display_name)
        app.row.json = data
        flag_modified(app.row, "json")
        db.commit()
        db.refresh(app.row)
        return ConnectorAppService._row_to_app(app.row)

    @staticmethod
    def _validate_configuration(
        *,
        visibility: str,
        allowed_roles: list[str] | None,
        transport: str,
        http_tools: list[dict] | list[ConnectorHttpToolDefinition] | None,
        tool_allowlist: list[str] | None,
    ) -> None:
        if visibility == "roles" and not allowed_roles:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Roles required")
        definitions = [
            (
                item
                if isinstance(item, ConnectorHttpToolDefinition)
                else ConnectorHttpToolDefinition.model_validate(item)
            )
            for item in (http_tools or [])
        ]
        if transport == "http" and not definitions:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                "HTTP tool definitions are required",
            )
        if transport != "http" and definitions:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                "HTTP tool definitions require the HTTP transport",
            )
        names = [definition.name for definition in definitions]
        if len(names) != len(set(names)):
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                "HTTP tool names must be unique",
            )
        if transport == "http" and set(tool_allowlist or []) - set(names):
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                "HTTP tool allowlist references an unknown tool",
            )

    @staticmethod
    def get_app(db: Session, app_id: int) -> ConnectorApp:
        row = (
            db.query(Kind)
            .filter(
                Kind.id == app_id,
                Kind.kind == CONNECTOR_APP_KIND,
                Kind.namespace == CONNECTOR_APP_NAMESPACE,
                Kind.is_active,
            )
            .first()
        )
        if not row:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Connector app not found")
        return ConnectorAppService._row_to_app(row)

    @staticmethod
    def get_app_by_slug(db: Session, slug: str) -> ConnectorApp | None:
        row = ConnectorAppService._find_row_by_slug(db, slug)
        return ConnectorAppService._row_to_app(row) if row else None

    @staticmethod
    def admin_response(db: Session, app: ConnectorApp) -> ConnectorAppAdminResponse:
        provider_headers = _decrypt_json(app.provider_headers_encrypted)
        connection_count = (
            db.query(Kind)
            .filter(
                Kind.kind == CONNECTOR_CONNECTION_KIND,
                Kind.namespace == CONNECTOR_CONNECTION_NAMESPACE,
                Kind.name == app.slug,
                Kind.is_active,
            )
            .count()
        )
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
            oauth_scope=app.oauth_scope,
            oauth_client_registered=bool(app.oauth_client_encrypted),
            transport=app.transport,
            mcp_url=app.mcp_url,
            tool_loading_mode=app.tool_loading_mode,
            keywords=list(app.keywords or []),
            provider_header_names=sorted(provider_headers),
            provider_headers_configured=bool(provider_headers),
            forward_user_context_headers=app.forward_user_context_headers,
            tool_allowlist=list(app.tool_allowlist or []),
            http_tools=list(app.http_tools or []),
            connection_count=connection_count,
            created_at=app.created_at,
            updated_at=app.updated_at,
        )

    @staticmethod
    def list_all_apps(db: Session) -> list[ConnectorApp]:
        rows = (
            db.query(Kind)
            .filter(
                Kind.kind == CONNECTOR_APP_KIND,
                Kind.namespace == CONNECTOR_APP_NAMESPACE,
                Kind.is_active,
            )
            .order_by(Kind.name, Kind.id)
            .all()
        )
        return [ConnectorAppService._row_to_app(row) for row in rows]

    @staticmethod
    def list_visible_apps(db: Session, user: User) -> list[ConnectorApp]:
        apps = [app for app in ConnectorAppService.list_all_apps(db) if app.enabled]
        return [
            app
            for app in apps
            if app.visibility == "all" or user.role in (app.allowed_roles or [])
        ]

    @staticmethod
    def split_by_availability(
        db: Session, user: User
    ) -> tuple[list[ConnectorApp], list[ConnectorApp]]:
        """Split visible apps into (callable now, needs authorization).

        Single source of truth for "can this user use the app", shared by the
        request builder's MCP injection and the conversation guidance.
        """
        visible_apps = ConnectorAppService.list_visible_apps(db, user)
        if not visible_apps:
            return [], []
        connections = connector_connection_service.list_for_user(db, user_id=user.id)
        available: list[ConnectorApp] = []
        pending: list[ConnectorApp] = []
        for app in visible_apps:
            if app.auth_type == "none":
                available.append(app)
            elif connector_connection_service.is_usable(connections.get(app.slug)):
                # An expired grant with a refresh token is still usable; the
                # runtime renews it on the next upstream call.
                available.append(app)
            else:
                pending.append(app)
        return available, pending

    @staticmethod
    def split_by_loading_mode(
        apps: list[ConnectorApp],
    ) -> tuple[list[ConnectorApp], list[ConnectorApp]]:
        """Split apps into static and lazy tool loading."""
        static = [app for app in apps if app.tool_loading_mode == "static"]
        lazy = [app for app in apps if app.tool_loading_mode == "lazy"]
        return static, lazy

    @staticmethod
    def user_response(
        db: Session, app: ConnectorApp, user: User
    ) -> ConnectorAppResponse:
        if app.auth_type == "none":
            connection = ConnectorConnectionResponse(
                status="connected",
                external_account_name=None,
                granted_scopes=[],
                expires_at=None,
            )
        else:
            connection = connector_connection_service.response(
                connector_connection_service.get(
                    db,
                    slug=app.slug,
                    user_id=user.id,
                )
            )
        return ConnectorAppResponse(
            id=app.id,
            slug=app.slug,
            name=app.name,
            description=app.description,
            icon_url=app.icon_url,
            auth_type=app.auth_type,
            tool_loading_mode=app.tool_loading_mode,
            connection=connection,
        )

    @staticmethod
    def delete_app(
        db: Session,
        app: ConnectorApp,
    ) -> None:
        """Permanently delete an app and every user connection bound to it.

        Connector apps are shared by all users, so deletion also removes the
        stored OAuth client and the connections of every user. Built-in apps
        are re-created by the next startup bootstrap.
        """
        db.query(Kind).filter(
            Kind.kind == CONNECTOR_CONNECTION_KIND,
            Kind.namespace == CONNECTOR_CONNECTION_NAMESPACE,
            Kind.name == app.slug,
        ).delete(synchronize_session=False)
        db.delete(app.row)
        db.commit()

    @staticmethod
    def _find_row_by_slug(db: Session, slug: str) -> Kind | None:
        return (
            db.query(Kind)
            .filter(
                Kind.kind == CONNECTOR_APP_KIND,
                Kind.namespace == CONNECTOR_APP_NAMESPACE,
                Kind.name == slug,
                Kind.is_active,
            )
            .first()
        )

    @staticmethod
    def _payload(payload: ConnectorAppWrite, created_by: int) -> dict[str, Any]:
        return {
            "apiVersion": "agent.wecode.io/v1",
            "kind": CONNECTOR_APP_KIND,
            "metadata": _metadata(payload.slug, payload.name),
            "spec": {
                "name": payload.name,
                "description": payload.description,
                "iconUrl": payload.icon_url,
                "enabled": payload.enabled,
                "visibility": payload.visibility,
                "allowedRoles": payload.allowed_roles,
                "authType": payload.auth_type,
                "oauthScope": payload.oauth_scope,
                "oauthClientEncrypted": None,
                "transport": payload.transport,
                "mcpUrl": payload.mcp_url,
                "toolLoadingMode": payload.tool_loading_mode,
                "keywords": payload.keywords,
                "providerHeadersEncrypted": _encrypt_json(payload.provider_headers),
                "forwardUserContextHeaders": payload.forward_user_context_headers,
                "toolAllowlist": payload.tool_allowlist,
                "httpTools": [
                    item.model_dump(mode="json") for item in payload.http_tools
                ],
                "createdBy": created_by,
            },
        }

    @staticmethod
    def _spec(row: Kind) -> dict[str, Any]:
        data = row.json or {}
        spec = data.get("spec") if isinstance(data, dict) else {}
        return dict(spec or {})

    @staticmethod
    def _row_to_app(row: Kind) -> ConnectorApp:
        spec = ConnectorAppService._spec(row)
        return ConnectorApp(
            id=row.id,
            slug=row.name,
            name=str(spec.get("name") or row.name),
            description=str(spec.get("description") or ""),
            icon_url=spec.get("iconUrl"),
            enabled=bool(spec.get("enabled", True)),
            visibility=str(spec.get("visibility") or "all"),
            allowed_roles=list(spec.get("allowedRoles") or []),
            auth_type=str(spec.get("authType") or "none"),
            oauth_scope=spec.get("oauthScope"),
            oauth_client_encrypted=spec.get("oauthClientEncrypted"),
            transport=str(spec.get("transport") or "streamable-http"),
            mcp_url=str(spec.get("mcpUrl") or ""),
            tool_loading_mode=(
                "lazy" if spec.get("toolLoadingMode") in {"lazy", "skill"} else "static"
            ),
            keywords=(
                [
                    keyword.strip()
                    for keyword in spec.get("keywords")
                    if isinstance(keyword, str) and keyword.strip()
                ]
                if isinstance(spec.get("keywords"), list)
                else []
            ),
            provider_headers_encrypted=spec.get("providerHeadersEncrypted"),
            forward_user_context_headers=bool(
                spec.get("forwardUserContextHeaders", False)
            ),
            tool_allowlist=list(spec.get("toolAllowlist") or []),
            http_tools=list(spec.get("httpTools") or []),
            created_by=spec.get("createdBy"),
            created_at=row.created_at,
            updated_at=row.updated_at,
            row=row,
        )

    @staticmethod
    def _spec_key(field: str) -> str:
        return {
            "icon_url": "iconUrl",
            "allowed_roles": "allowedRoles",
            "auth_type": "authType",
            "oauth_scope": "oauthScope",
            "mcp_url": "mcpUrl",
            "tool_loading_mode": "toolLoadingMode",
            "keywords": "keywords",
            "forward_user_context_headers": "forwardUserContextHeaders",
            "tool_allowlist": "toolAllowlist",
            "http_tools": "httpTools",
        }.get(field, field)


connector_app_service = ConnectorAppService()
