# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Persist user-owned external source connections in the existing Kind table."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any
from uuid import uuid4

from sqlalchemy.orm import Session

from app.models.kind import Kind
from shared.utils.crypto import decrypt_sensitive_data, encrypt_sensitive_data

EXTERNAL_SOURCE_CONNECTION_KIND = "ExternalSourceConnection"
MAX_EXTERNAL_SOURCE_CONNECTIONS = 20


@dataclass(frozen=True)
class ExternalSourceConnection:
    """Decrypted runtime view; plaintext credentials must never be serialized."""

    connection_id: str
    provider_id: str
    owner_user_id: int
    display_name: str
    adapter_type: str
    enabled: bool
    config: dict[str, Any]
    credentials: dict[str, str]
    row: Kind


class ExternalSourceConnectionService:
    """Small interface over connection validation, encryption and Kind storage."""

    @staticmethod
    def list_owned(
        db: Session, *, owner_user_id: int, provider_id: str
    ) -> list[ExternalSourceConnection]:
        rows = (
            db.query(Kind)
            .filter(
                Kind.kind == EXTERNAL_SOURCE_CONNECTION_KIND,
                Kind.namespace == provider_id,
                Kind.user_id == owner_user_id,
                Kind.is_active.is_(True),
            )
            .order_by(Kind.created_at.asc(), Kind.id.asc())
            .all()
        )
        return [ExternalSourceConnectionService._from_row(row) for row in rows]

    @staticmethod
    def get_owned(
        db: Session,
        *,
        owner_user_id: int,
        provider_id: str,
        connection_id: str,
        include_inactive: bool = False,
    ) -> ExternalSourceConnection | None:
        query = db.query(Kind).filter(
            Kind.kind == EXTERNAL_SOURCE_CONNECTION_KIND,
            Kind.namespace == provider_id,
            Kind.name == connection_id,
            Kind.user_id == owner_user_id,
        )
        if not include_inactive:
            query = query.filter(Kind.is_active.is_(True))
        row = query.first()
        return ExternalSourceConnectionService._from_row(row) if row else None

    @staticmethod
    def save_owned(
        db: Session,
        *,
        owner_user_id: int,
        provider_id: str,
        display_name: str,
        adapter_type: str,
        enabled: bool,
        config: dict[str, Any],
        credentials: dict[str, str],
        connection_id: str | None = None,
    ) -> ExternalSourceConnection:
        existing = None
        if connection_id:
            existing = ExternalSourceConnectionService.get_owned(
                db,
                owner_user_id=owner_user_id,
                provider_id=provider_id,
                connection_id=connection_id,
                include_inactive=True,
            )
            if existing is None:
                raise ValueError("External source connection not found")
        elif (
            len(
                ExternalSourceConnectionService.list_owned(
                    db, owner_user_id=owner_user_id, provider_id=provider_id
                )
            )
            >= MAX_EXTERNAL_SOURCE_CONNECTIONS
        ):
            raise ValueError("External source connection limit reached")

        connection_id = connection_id or f"conn_{uuid4().hex[:24]}"
        encrypted_credentials = {
            key: encrypt_sensitive_data(value)
            for key, value in credentials.items()
            if value
        }
        if existing:
            old_spec = dict((existing.row.json or {}).get("spec") or {})
            old_credentials = dict(old_spec.get("credentialsEncrypted") or {})
            encrypted_credentials = {**old_credentials, **encrypted_credentials}

        payload = {
            "apiVersion": "agent.wecode.io/v1",
            "kind": EXTERNAL_SOURCE_CONNECTION_KIND,
            "metadata": {"name": connection_id, "namespace": provider_id},
            "spec": {
                "displayName": display_name.strip(),
                "adapterType": adapter_type,
                "enabled": enabled,
                "config": dict(config),
                "credentialsEncrypted": encrypted_credentials,
            },
        }
        if existing:
            row = existing.row
            row.json = payload
            row.is_active = True
        else:
            row = Kind(
                user_id=owner_user_id,
                kind=EXTERNAL_SOURCE_CONNECTION_KIND,
                namespace=provider_id,
                name=connection_id,
                json=payload,
                is_active=True,
            )
            db.add(row)
        db.commit()
        db.refresh(row)
        return ExternalSourceConnectionService._from_row(row)

    @staticmethod
    def disable_owned(
        db: Session,
        *,
        owner_user_id: int,
        provider_id: str,
        connection_id: str,
    ) -> bool:
        connection = ExternalSourceConnectionService.get_owned(
            db,
            owner_user_id=owner_user_id,
            provider_id=provider_id,
            connection_id=connection_id,
        )
        if not connection:
            return False
        connection.row.is_active = False
        db.commit()
        return True

    @staticmethod
    def _from_row(row: Kind) -> ExternalSourceConnection:
        spec = dict((row.json or {}).get("spec") or {})
        encrypted = dict(spec.get("credentialsEncrypted") or {})
        credentials = {
            key: decrypt_sensitive_data(value) or ""
            for key, value in encrypted.items()
            if isinstance(value, str) and value
        }
        return ExternalSourceConnection(
            connection_id=row.name,
            provider_id=row.namespace,
            owner_user_id=row.user_id,
            display_name=str(spec.get("displayName") or row.name),
            adapter_type=str(spec.get("adapterType") or ""),
            enabled=bool(spec.get("enabled", True)),
            config=dict(spec.get("config") or {}),
            credentials=credentials,
            row=row,
        )


external_source_connection_service = ExternalSourceConnectionService()
