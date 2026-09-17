# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Short-lived, provider-backed VNC proxy sessions."""

import hashlib
import logging
import secrets
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Protocol
from urllib.parse import urlencode, urlsplit, urlunsplit

from app.core.cache import cache_manager
from app.core.config import settings
from app.schemas.device import DeviceType
from app.services.device.runtime_route import resolve_runtime_route_identity
from app.services.device.session_service import (
    DEFAULT_SESSION_TTL_SECONDS,
    DeviceSessionError,
    DeviceSessionNotFoundError,
)

logger = logging.getLogger(__name__)

VNC_CONNECT_TICKET_TTL_SECONDS = 60
VNC_SESSION_KEY_PREFIX = "vnc_session:"
VNC_TICKET_KEY_PREFIX = "vnc_connect_ticket:"
VNC_SESSION_ID_TOKEN_BYTES = 18
VNC_CONNECT_TICKET_BYTES = 32


@dataclass(frozen=True)
class VncUpstream:
    """Backend-only connection details returned by a device provider."""

    url: str
    headers: dict[str, str]
    provider: str
    sandbox_id: str | None = None


@dataclass(frozen=True)
class VncSessionRecord:
    """Authorization and upstream metadata persisted for one proxy session."""

    session_id: str
    actor_user_id: int
    owner_user_id: int
    device_id: str
    device_type: DeviceType
    provider: str
    upstream_url: str
    sandbox_id: str | None
    expires_at: datetime

    def to_dict(self) -> dict[str, Any]:
        return {
            "session_id": self.session_id,
            "actor_user_id": self.actor_user_id,
            "owner_user_id": self.owner_user_id,
            "device_id": self.device_id,
            "device_type": self.device_type.value,
            "provider": self.provider,
            "upstream_url": self.upstream_url,
            "sandbox_id": self.sandbox_id,
            "expires_at": self.expires_at.isoformat(),
        }

    @classmethod
    def from_dict(cls, value: Any) -> "VncSessionRecord":
        if not isinstance(value, dict):
            raise ValueError("VNC session record must be an object")
        expires_at = datetime.fromisoformat(str(value["expires_at"]))
        if expires_at.tzinfo is None:
            expires_at = expires_at.replace(tzinfo=timezone.utc)
        return cls(
            session_id=str(value["session_id"]),
            actor_user_id=int(value["actor_user_id"]),
            owner_user_id=int(value["owner_user_id"]),
            device_id=str(value["device_id"]),
            device_type=DeviceType(str(value["device_type"])),
            provider=str(value["provider"]),
            upstream_url=str(value["upstream_url"]),
            sandbox_id=(str(value["sandbox_id"]) if value.get("sandbox_id") else None),
            expires_at=expires_at,
        )


class VncSessionProvider(Protocol):
    """Prepare one Backend-to-device VNC upstream."""

    async def prepare(
        self,
        *,
        db: Any,
        user_id: int,
        device_id: str,
    ) -> VncUpstream:
        """Validate the live device and return Backend-only connection details."""

    async def authorize(
        self,
        *,
        db: Any,
        record: VncSessionRecord,
    ) -> VncUpstream:
        """Revalidate a stored record and return fresh upstream credentials."""


class VncSessionProviderRegistry:
    """Explicit device-type registry kept independent from internal packages."""

    def __init__(self) -> None:
        self._providers: dict[DeviceType, VncSessionProvider] = {}

    def register(self, device_type: DeviceType, provider: VncSessionProvider) -> None:
        if device_type in self._providers:
            raise RuntimeError(
                f"VNC session provider already registered for {device_type.value}"
            )
        self._providers[device_type] = provider

    def get(self, device_type: DeviceType) -> VncSessionProvider | None:
        return self._providers.get(device_type)


class VncSessionStore:
    """Exact-key Redis storage for one-time tickets and active sessions."""

    async def register(
        self,
        record: VncSessionRecord,
        ticket: str,
        *,
        ttl_seconds: int,
    ) -> None:
        stored = await cache_manager.set_or_raise(
            _session_key(record.session_id),
            record.to_dict(),
            expire=ttl_seconds,
        )
        if not stored:
            raise RuntimeError("Failed to persist VNC session")
        try:
            ticket_stored = await cache_manager.set_or_raise(
                _ticket_key(ticket),
                {"session_id": record.session_id},
                expire=min(ttl_seconds, VNC_CONNECT_TICKET_TTL_SECONDS),
            )
            if not ticket_stored:
                raise RuntimeError("Failed to persist VNC connect ticket")
        except Exception:
            await cache_manager.delete_or_raise(_session_key(record.session_id))
            raise

    async def consume_ticket(
        self,
        session_id: str,
        ticket: str,
    ) -> VncSessionRecord | None:
        ticket_record = await cache_manager.pop_or_raise(_ticket_key(ticket))
        if not isinstance(ticket_record, dict):
            return None
        if (
            secrets.compare_digest(
                str(ticket_record.get("session_id") or ""),
                session_id,
            )
            is False
        ):
            return None
        return await self.get(session_id)

    async def get(self, session_id: str) -> VncSessionRecord | None:
        value = await cache_manager.get_or_raise(_session_key(session_id))
        if value is None:
            return None
        try:
            record = VncSessionRecord.from_dict(value)
        except (KeyError, TypeError, ValueError):
            logger.error("Invalid VNC session record: session_id=%s", session_id)
            return None
        if record.expires_at <= datetime.now(timezone.utc):
            return None
        return record

    async def revoke(self, session_id: str) -> bool:
        return await cache_manager.delete_or_raise(_session_key(session_id))


class VncSessionService:
    """Resolve a device provider and issue a short-lived proxy session."""

    def __init__(
        self,
        registry: VncSessionProviderRegistry,
        store: VncSessionStore,
    ) -> None:
        self._registry = registry
        self._store = store

    async def start_session(
        self,
        *,
        db: Any,
        actor_user_id: int,
        owner_user_id: int,
        device_id: str,
        ttl_seconds: int = DEFAULT_SESSION_TTL_SECONDS,
    ) -> dict[str, Any]:
        identity = resolve_runtime_route_identity(
            db,
            user_id=owner_user_id,
            submitted_device_id=device_id,
        )
        if identity is None:
            raise DeviceSessionNotFoundError("Device not found or access denied")
        provider = self._registry.get(identity.device_type)
        if provider is None:
            raise DeviceSessionError(
                "VNC desktop sessions are unavailable on this device"
            )

        normalized_ttl = max(1, min(int(ttl_seconds), DEFAULT_SESSION_TTL_SECONDS))
        upstream = await provider.prepare(
            db=db,
            user_id=owner_user_id,
            device_id=identity.logical_device_id,
        )
        session_id = f"vnc-{secrets.token_urlsafe(VNC_SESSION_ID_TOKEN_BYTES)}"
        ticket = secrets.token_urlsafe(VNC_CONNECT_TICKET_BYTES)
        expires_at = datetime.now(timezone.utc) + timedelta(seconds=normalized_ttl)
        record = VncSessionRecord(
            session_id=session_id,
            actor_user_id=actor_user_id,
            owner_user_id=owner_user_id,
            device_id=identity.logical_device_id,
            device_type=identity.device_type,
            provider=upstream.provider,
            upstream_url=upstream.url,
            sandbox_id=upstream.sandbox_id,
            expires_at=expires_at,
        )
        try:
            await self._store.register(record, ticket, ttl_seconds=normalized_ttl)
        except Exception as exc:
            raise DeviceSessionError("Failed to persist VNC session metadata") from exc

        logger.info(
            "VNC session created: session_id=%s actor_user_id=%s owner_user_id=%s "
            "device_id=%s provider=%s",
            session_id,
            actor_user_id,
            owner_user_id,
            identity.logical_device_id,
            upstream.provider,
        )
        return {
            "session_id": session_id,
            "device_id": identity.logical_device_id,
            "type": "vnc",
            "path": "",
            "url": _build_proxy_url(session_id, ticket),
            "transport": "websocket",
            "expires_at": expires_at,
        }

    async def authorize_connection(
        self,
        *,
        db: Any,
        record: VncSessionRecord,
    ) -> VncUpstream | None:
        """Revalidate access and obtain credentials immediately before proxying."""
        from app.models.user import User

        actor = db.query(User).filter(User.id == record.actor_user_id).first()
        if actor is None or not actor.is_active:
            return None
        if (
            record.actor_user_id != record.owner_user_id
            and getattr(actor, "role", "user") != "admin"
        ):
            return None

        identity = resolve_runtime_route_identity(
            db,
            user_id=record.owner_user_id,
            submitted_device_id=record.device_id,
        )
        if (
            identity is None
            or identity.logical_device_id != record.device_id
            or identity.device_type != record.device_type
        ):
            return None
        provider = self._registry.get(record.device_type)
        if provider is None:
            return None
        try:
            upstream = await provider.authorize(db=db, record=record)
        except DeviceSessionError:
            return None
        if (
            upstream.provider != record.provider
            or upstream.sandbox_id != record.sandbox_id
        ):
            return None
        return upstream

    async def revoke_session(
        self,
        *,
        session_id: str,
        user_id: int,
        allow_admin: bool = False,
    ) -> bool:
        record = await self._store.get(session_id)
        if record is None:
            return False
        if (
            user_id not in {record.actor_user_id, record.owner_user_id}
            and not allow_admin
        ):
            raise DeviceSessionNotFoundError("VNC session not found or access denied")
        return await self._store.revoke(session_id)


def _validated_upstream_url(value: Any) -> str:
    if not isinstance(value, str):
        raise DeviceSessionError("VNC provider returned an invalid upstream URL")
    parsed = urlsplit(value)
    if (
        parsed.scheme not in {"ws", "wss"}
        or not parsed.hostname
        or parsed.username
        or parsed.password
    ):
        raise DeviceSessionError("VNC provider returned an invalid upstream URL")
    return value


def _build_proxy_url(session_id: str, ticket: str) -> str:
    base_url = settings.WEGENT_SOCKET_URL or settings.WEGENT_BACKEND_PUBLIC_URL
    parsed = urlsplit(base_url)
    if parsed.scheme not in {"http", "https", "ws", "wss"} or not parsed.netloc:
        raise DeviceSessionError("Backend public WebSocket URL is not configured")
    scheme = "wss" if parsed.scheme in {"https", "wss"} else "ws"
    return urlunsplit(
        (
            scheme,
            parsed.netloc,
            f"/vnc-proxy/sessions/{session_id}",
            urlencode({"ticket": ticket}),
            "",
        )
    )


def _session_key(session_id: str) -> str:
    return f"{VNC_SESSION_KEY_PREFIX}{session_id}"


def _ticket_key(ticket: str) -> str:
    digest = hashlib.sha256(ticket.encode("utf-8")).hexdigest()
    return f"{VNC_TICKET_KEY_PREFIX}{digest}"


vnc_session_provider_registry = VncSessionProviderRegistry()
vnc_session_store = VncSessionStore()
vnc_session_service = VncSessionService(
    vnc_session_provider_registry,
    vnc_session_store,
)
