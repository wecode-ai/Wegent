"""User-scoped connector authorization state."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.schemas.connector import ConnectorConnectionResponse
from shared.utils.crypto import decrypt_sensitive_data, encrypt_sensitive_data

CONNECTOR_CONNECTION_KIND = "ConnectorConnection"
CONNECTOR_CONNECTION_NAMESPACE = "system"


def _parse_timestamp(value: Any) -> datetime | None:
    """Parse a stored ISO-8601 timestamp into a naive UTC datetime."""
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo:
        parsed = parsed.replace(tzinfo=None)
    return parsed


def _parse_last_error(value: Any) -> str | None:
    """Extract a readable message from the stored failure record."""
    if isinstance(value, dict):
        message = value.get("message")
        return message if isinstance(message, str) and message else None
    if isinstance(value, str):
        return value or None
    return None


def _grant_snapshot(spec: dict[str, Any]) -> str:
    """Identify the grant a refresh started from.

    Refresh results are only written back while this value still matches, so a
    request that was overtaken by another refresh, a re-authorization or a
    disconnect cannot resurrect or overwrite the newer credentials.
    """
    return str(spec.get("refreshTokenEncrypted") or "")


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
    tool_summaries: list[dict[str, Any]]
    tools_discovered_at: datetime | None
    last_error: str | None
    row: Kind

    def access_token(self) -> str:
        """Return the decrypted token, or ``""`` when it cannot be decrypted.

        ``decrypt_sensitive_data`` echoes the ciphertext back when the
        configured key cannot read it. Sending that as a bearer token only
        produces an upstream 401, so treat it as a missing credential and let
        the caller ask for authorization again.
        """
        encrypted = self.access_token_encrypted or ""
        if not encrypted:
            return ""
        decrypted = decrypt_sensitive_data(encrypted) or ""
        return "" if decrypted == encrypted else decrypted

    def refresh_token(self) -> str | None:
        """Return the decrypted refresh token, or ``None`` when unreadable.

        ``decrypt_sensitive_data`` echoes the ciphertext back when the
        configured key cannot read it. Posting that to the token endpoint
        presents a garbage grant, and a 4xx answer then wipes a refresh token
        that a corrected key could still have used.
        """
        encrypted = self.refresh_token_encrypted
        if not encrypted:
            return None
        decrypted = decrypt_sensitive_data(encrypted) or ""
        return None if decrypted == encrypted else decrypted or None


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
    def list_for_user(db: Session, *, user_id: int) -> dict[str, ConnectorConnection]:
        """Return every active connection of one user keyed by connector slug."""
        rows = (
            db.query(Kind)
            .filter(
                Kind.kind == CONNECTOR_CONNECTION_KIND,
                Kind.namespace == CONNECTOR_CONNECTION_NAMESPACE,
                Kind.user_id == user_id,
                Kind.is_active,
            )
            .all()
        )
        return {
            row.name: ConnectorConnectionService._row_to_connection(row) for row in rows
        }

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
        expected_refresh_token_encrypted: str | None = None,
        expected_access_token_encrypted: str | None = None,
    ) -> ConnectorConnection | None:
        """Persist a grant for ``slug``.

        ``expected_refresh_token_encrypted`` turns the write into a conditional
        one: a refresh only commits while the grant it started from is still
        the stored grant. Racing refreshes, re-authorizations and disconnects
        then win over the older result, which returns ``None`` so the caller can
        re-read the current connection instead of trusting a stale snapshot.

        A token endpoint rotates the refresh token on first use, so the request
        that loses that race is answered with ``invalid_grant`` for the same
        starting grant. When that rejection commits first it clears the grant,
        and the delayed successful rotation must still be able to restore it:
        the write is also accepted while the connection is expired without a
        refresh token and still carries the access token the caller started
        from. ``expected_access_token_encrypted`` supplies that check.
        """
        spec = {
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
        }
        row = ConnectorConnectionService._lock_row(db, slug=slug, user_id=user_id)
        if row is None:
            if expected_refresh_token_encrypted is not None:
                db.commit()
                return None
            row = Kind(
                user_id=user_id,
                kind=CONNECTOR_CONNECTION_KIND,
                namespace=CONNECTOR_CONNECTION_NAMESPACE,
                name=slug,
                json={
                    "apiVersion": "agent.wecode.io/v1",
                    "kind": CONNECTOR_CONNECTION_KIND,
                    "metadata": {
                        "name": slug,
                        "namespace": CONNECTOR_CONNECTION_NAMESPACE,
                    },
                    "spec": spec,
                },
                is_active=True,
            )
            db.add(row)
            db.commit()
            db.refresh(row)
            return ConnectorConnectionService._row_to_connection(row)
        current = dict((row.json or {}).get("spec") or {})
        if expected_refresh_token_encrypted is not None:
            if not row.is_active:
                # Disconnecting during the refresh stays disconnected.
                db.commit()
                return None
            if _grant_snapshot(current) != expected_refresh_token_encrypted:
                # The starting grant is gone: a competing rejection cleared it,
                # or the user re-authorized / disconnected. Only the rejection
                # case leaves the starting access token in place.
                cleared_by_rejection = (
                    not _grant_snapshot(current)
                    and str(current.get("status") or "") == "expired"
                    and expected_access_token_encrypted is not None
                    and str(current.get("accessTokenEncrypted") or "")
                    == expected_access_token_encrypted
                )
                if not cleared_by_rejection:
                    db.commit()
                    return None
        if row.is_active:
            # A refresh keeps the existing discovery result: the account and the
            # tools it can see did not change, only the tokens.
            for key in ("toolSummaries", "toolsDiscoveredAt"):
                if key in current:
                    spec[key] = current[key]
        row.is_active = True
        return ConnectorConnectionService._save_spec(db, row=row, spec=spec)

    @staticmethod
    def set_status(
        db: Session,
        connection: ConnectorConnection,
        status: str,
    ) -> ConnectorConnection:
        row = ConnectorConnectionService._lock_row(
            db, slug=connection.slug, user_id=connection.user_id
        )
        if row is None:
            db.commit()
            return connection
        spec = dict((row.json or {}).get("spec") or {})
        spec["status"] = status
        return ConnectorConnectionService._save_spec(db, row=row, spec=spec)

    @staticmethod
    def clear_refresh_token(
        db: Session,
        connection: ConnectorConnection,
    ) -> ConnectorConnection:
        """Stop offering a grant the token endpoint already rejected."""
        row = ConnectorConnectionService._lock_row(
            db, slug=connection.slug, user_id=connection.user_id
        )
        if row is None:
            db.commit()
            return connection
        spec = dict((row.json or {}).get("spec") or {})
        spec["refreshTokenEncrypted"] = None
        return ConnectorConnectionService._save_spec(db, row=row, spec=spec)

    @staticmethod
    def reject_refresh_if_current(
        db: Session,
        *,
        connection: ConnectorConnection,
        expected_refresh_token_encrypted: str,
        clear_refresh_token: bool,
    ) -> ConnectorConnection | None:
        """Record a failed refresh unless a newer grant already replaced it.

        Returns the connection that still carries the grant the caller started
        from, or ``None`` when another request committed a newer grant or
        disconnected the account first.
        """
        row = ConnectorConnectionService._lock_row(
            db, slug=connection.slug, user_id=connection.user_id
        )
        if row is None:
            db.commit()
            return None
        spec = dict((row.json or {}).get("spec") or {})
        if not row.is_active or (
            _grant_snapshot(spec) != expected_refresh_token_encrypted
        ):
            db.commit()
            return None
        spec["status"] = "expired"
        if clear_refresh_token:
            spec["refreshTokenEncrypted"] = None
        return ConnectorConnectionService._save_spec(db, row=row, spec=spec)

    @staticmethod
    def is_usable(connection: ConnectorConnection | None) -> bool:
        """Whether the caller can use this connection right now.

        An expired grant still works while a refresh token can renew it: the
        runtime refreshes it on the next upstream call. A rejected grant loses
        its refresh token, so it stops looking usable and guidance asks for
        authorization again.
        """
        if connection is None:
            return False
        status = ConnectorConnectionService.response(connection).status
        if status == "connected":
            return True
        return status == "expired" and bool(connection.refresh_token())

    @staticmethod
    def _lock_row(db: Session, *, slug: str, user_id: int) -> Kind | None:
        """Re-read one connection under a row lock before writing to it.

        Every writer merges into the stored document instead of replacing it
        with the snapshot it read earlier. ``populate_existing`` drops a stale
        identity-map copy so the merge starts from the committed row, and the
        lock keeps the read-compare-write window closed for other requests.
        """
        return (
            db.query(Kind)
            .filter(
                Kind.kind == CONNECTOR_CONNECTION_KIND,
                Kind.namespace == CONNECTOR_CONNECTION_NAMESPACE,
                Kind.name == slug,
                Kind.user_id == user_id,
            )
            .populate_existing()
            .with_for_update()
            .first()
        )

    @staticmethod
    def _save_spec(
        db: Session,
        *,
        row: Kind,
        spec: dict[str, Any],
    ) -> ConnectorConnection:
        payload = dict(row.json or {})
        payload["spec"] = spec
        row.json = payload
        db.commit()
        db.refresh(row)
        return ConnectorConnectionService._row_to_connection(row)

    @staticmethod
    def save_tool_summaries(
        db: Session,
        connection: ConnectorConnection,
        summaries: list[dict[str, Any]],
    ) -> ConnectorConnection:
        row = ConnectorConnectionService._lock_row(
            db, slug=connection.slug, user_id=connection.user_id
        )
        if row is None:
            db.commit()
            return connection
        spec = dict((row.json or {}).get("spec") or {})
        spec["toolSummaries"] = summaries
        spec["toolsDiscoveredAt"] = datetime.now(timezone.utc).isoformat()
        # A successful discovery clears the previous upstream failure.
        spec["lastError"] = None
        return ConnectorConnectionService._save_spec(db, row=row, spec=spec)

    @staticmethod
    def record_tool_error(
        db: Session,
        connection: ConnectorConnection,
        message: str,
    ) -> ConnectorConnection:
        """Remember a discovery failure without changing the authorization."""
        row = ConnectorConnectionService._lock_row(
            db, slug=connection.slug, user_id=connection.user_id
        )
        if row is None:
            db.commit()
            return connection
        spec = dict((row.json or {}).get("spec") or {})
        spec["lastError"] = {
            "message": message[:500],
            "at": datetime.now(timezone.utc).isoformat(),
        }
        return ConnectorConnectionService._save_spec(db, row=row, spec=spec)

    @staticmethod
    def disconnect(db: Session, *, slug: str, user_id: int) -> bool:
        row = ConnectorConnectionService._lock_row(db, slug=slug, user_id=user_id)
        if row is None or not row.is_active:
            db.commit()
            return False
        spec = dict((row.json or {}).get("spec") or {})
        spec.update(
            {
                "status": "disconnected",
                "accessTokenEncrypted": None,
                "refreshTokenEncrypted": None,
                "toolSummaries": [],
            }
        )
        row.is_active = False
        ConnectorConnectionService._save_spec(db, row=row, spec=spec)
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
            last_error=connection.last_error,
            last_discovered_at=connection.tools_discovered_at,
            tool_count=len(connection.tool_summaries),
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
            tool_summaries=[
                item
                for item in (spec.get("toolSummaries") or [])
                if isinstance(item, dict)
            ],
            tools_discovered_at=_parse_timestamp(spec.get("toolsDiscoveredAt")),
            last_error=_parse_last_error(spec.get("lastError")),
            row=row,
        )


connector_connection_service = ConnectorConnectionService()
