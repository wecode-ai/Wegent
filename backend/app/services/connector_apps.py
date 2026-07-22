# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Connector app catalog services backed by the generic kinds table."""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime
from typing import Any

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
from shared.utils.crypto import decrypt_sensitive_data, encrypt_sensitive_data

CONNECTOR_APP_KIND = "ConnectorApp"
CONNECTOR_APP_NAMESPACE = "system"
CONNECTOR_APP_USER_ID = 0


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
    transport: str
    mcp_url: str
    provider_headers_encrypted: str | None
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
            },
        )
        for key, value in values.items():
            current[ConnectorAppService._spec_key(key)] = value

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
            provider_header_names=sorted(provider_headers),
            provider_headers_configured=bool(provider_headers),
            tool_allowlist=list(app.tool_allowlist or []),
            http_tools=list(app.http_tools or []),
            connection_count=0,
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
    def user_response(
        db: Session, app: ConnectorApp, user: User
    ) -> ConnectorAppResponse:
        return ConnectorAppResponse(
            id=app.id,
            slug=app.slug,
            name=app.name,
            description=app.description,
            icon_url=app.icon_url,
            auth_type=app.auth_type,
            connection=ConnectorConnectionResponse(
                status="connected",
                external_account_name=None,
                granted_scopes=[],
                expires_at=None,
            ),
        )

    @staticmethod
    def disable_app(db: Session, app: ConnectorApp) -> None:
        app.row.is_active = False
        spec = ConnectorAppService._spec(app.row)
        spec["enabled"] = False
        data = dict(app.row.json or {})
        data["spec"] = spec
        app.row.json = data
        flag_modified(app.row, "json")
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
                "transport": payload.transport,
                "mcpUrl": payload.mcp_url,
                "providerHeadersEncrypted": _encrypt_json(payload.provider_headers),
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
            transport=str(spec.get("transport") or "streamable-http"),
            mcp_url=str(spec.get("mcpUrl") or ""),
            provider_headers_encrypted=spec.get("providerHeadersEncrypted"),
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
            "mcp_url": "mcpUrl",
            "tool_allowlist": "toolAllowlist",
            "http_tools": "httpTools",
        }.get(field, field)


connector_app_service = ConnectorAppService()
