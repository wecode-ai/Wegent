"""User-scoped connector authorization state."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone

from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.schemas.connector import ConnectorConnectionResponse
from shared.utils.crypto import decrypt_sensitive_data, encrypt_sensitive_data

CONNECTOR_CONNECTION_KIND = "ConnectorConnection"
CONNECTOR_CONNECTION_NAMESPACE = "system"


@dataclass
class ConnectorConnection:
    """Runtime view of one user's connector authorization."""

    slug: str
    user_id: int
    status: str
    external_account_name: str | None
    granted_scopes: list[str]
    expires_at: datetime | None
    access_token_encrypted: str
    refresh_token_encrypted: str | None
    token_type: str
    row: Kind

    def access_token(self) -> str:
        return decrypt_sensitive_data(self.access_token_encrypted) or ""

    def refresh_token(self) -> str | None:
        if not self.refresh_token_encrypted:
            return None
        return decrypt_sensitive_data(self.refresh_token_encrypted) or None


class ConnectorConnectionService:
    """Persist connector credentials without exposing their plaintext."""

    @staticmethod
    def get(
        db: Session,
        *,
        slug: str,
        user_id: int,
    ) -> ConnectorConnection | None:
        row = (
            db.query(Kind)
            .filter(
                Kind.kind == CONNECTOR_CONNECTION_KIND,
                Kind.namespace == CONNECTOR_CONNECTION_NAMESPACE,
                Kind.name == slug,
                Kind.user_id == user_id,
                Kind.is_active,
            )
            .first()
        )
        return ConnectorConnectionService._row_to_connection(row) if row else None

    @staticmethod
    def save_oauth_connection(
        db: Session,
        *,
        slug: str,
        user_id: int,
        access_token: str,
        refresh_token: str | None,
        token_type: str,
        granted_scopes: list[str],
        external_account_name: str | None,
        expires_at: datetime | None,
    ) -> ConnectorConnection:
        row = (
            db.query(Kind)
            .filter(
                Kind.kind == CONNECTOR_CONNECTION_KIND,
                Kind.namespace == CONNECTOR_CONNECTION_NAMESPACE,
                Kind.name == slug,
                Kind.user_id == user_id,
            )
            .first()
        )
        payload = {
            "apiVersion": "agent.wecode.io/v1",
            "kind": CONNECTOR_CONNECTION_KIND,
            "metadata": {
                "name": slug,
                "namespace": CONNECTOR_CONNECTION_NAMESPACE,
            },
            "spec": {
                "connectorAppSlug": slug,
                "status": "connected",
                "externalAccountName": external_account_name,
                "grantedScopes": sorted(set(granted_scopes)),
                "expiresAt": expires_at.isoformat() if expires_at else None,
                "accessTokenEncrypted": encrypt_sensitive_data(access_token),
                "refreshTokenEncrypted": (
                    encrypt_sensitive_data(refresh_token) if refresh_token else None
                ),
                "tokenType": token_type or "bearer",
            },
        }
        if row:
            row.json = payload
            row.is_active = True
        else:
            row = Kind(
                user_id=user_id,
                kind=CONNECTOR_CONNECTION_KIND,
                namespace=CONNECTOR_CONNECTION_NAMESPACE,
                name=slug,
                json=payload,
                is_active=True,
            )
            db.add(row)
        db.commit()
        db.refresh(row)
        return ConnectorConnectionService._row_to_connection(row)

    @staticmethod
    def set_status(
        db: Session,
        connection: ConnectorConnection,
        status: str,
    ) -> ConnectorConnection:
        payload = dict(connection.row.json or {})
        spec = dict(payload.get("spec") or {})
        spec["status"] = status
        payload["spec"] = spec
        connection.row.json = payload
        db.commit()
        db.refresh(connection.row)
        return ConnectorConnectionService._row_to_connection(connection.row)

    @staticmethod
    def disconnect(db: Session, *, slug: str, user_id: int) -> bool:
        connection = ConnectorConnectionService.get(db, slug=slug, user_id=user_id)
        if not connection:
            return False
        connection.row.is_active = False
        payload = dict(connection.row.json or {})
        spec = dict(payload.get("spec") or {})
        spec.update(
            {
                "status": "disconnected",
                "accessTokenEncrypted": None,
                "refreshTokenEncrypted": None,
            }
        )
        payload["spec"] = spec
        connection.row.json = payload
        db.commit()
        return True

    @staticmethod
    def response(
        connection: ConnectorConnection | None,
    ) -> ConnectorConnectionResponse:
        if not connection:
            return ConnectorConnectionResponse(status="disconnected")
        status = connection.status
        if (
            status == "connected"
            and connection.expires_at
            and connection.expires_at <= datetime.now(timezone.utc).replace(tzinfo=None)
        ):
            status = "expired"
        return ConnectorConnectionResponse(
            status=status,
            external_account_name=connection.external_account_name,
            granted_scopes=connection.granted_scopes,
            expires_at=connection.expires_at,
        )

    @staticmethod
    def _row_to_connection(row: Kind) -> ConnectorConnection:
        spec = dict((row.json or {}).get("spec") or {})
        expires_at_raw = spec.get("expiresAt")
        expires_at = None
        if isinstance(expires_at_raw, str) and expires_at_raw:
            expires_at = datetime.fromisoformat(expires_at_raw.replace("Z", "+00:00"))
            if expires_at.tzinfo:
                expires_at = expires_at.replace(tzinfo=None)
        return ConnectorConnection(
            slug=row.name,
            user_id=row.user_id,
            status=str(spec.get("status") or "disconnected"),
            external_account_name=spec.get("externalAccountName"),
            granted_scopes=list(spec.get("grantedScopes") or []),
            expires_at=expires_at,
            access_token_encrypted=str(spec.get("accessTokenEncrypted") or ""),
            refresh_token_encrypted=spec.get("refreshTokenEncrypted"),
            token_type=str(spec.get("tokenType") or "bearer"),
            row=row,
        )


connector_connection_service = ConnectorConnectionService()
