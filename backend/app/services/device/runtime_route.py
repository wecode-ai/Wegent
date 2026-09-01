# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Resolve an owned logical device identity to its current Runtime socket."""

import asyncio
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from sqlalchemy import and_
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.schemas.device import DeviceType
from app.services.device_service import device_service
from shared.telemetry.decorators import trace_async


class RuntimeRouteError(RuntimeError):
    """Stable failure raised while resolving a device Runtime route."""

    def __init__(
        self,
        code: str,
        message: str,
        *,
        retryable: bool = False,
        details: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.retryable = retryable
        self.details = details or {}


@dataclass(frozen=True)
class RuntimeRouteIdentity:
    """Database-owned mapping between logical and Runtime device identities."""

    logical_device_id: str
    runtime_device_id: str
    runtime_instance_id: str | None
    device_type: DeviceType
    app_device_id: str | None = None


@dataclass(frozen=True)
class RuntimeRoute:
    """One currently online Runtime route."""

    logical_device_id: str
    runtime_device_id: str
    runtime_instance_id: str | None
    device_type: DeviceType
    socket_id: str
    online_info: dict[str, Any]
    app_device_id: str | None = None


def _device_type(device: Kind) -> DeviceType:
    spec = device.json.get("spec", {}) if isinstance(device.json, dict) else {}
    raw_type = spec.get("deviceType", DeviceType.LOCAL.value)
    try:
        return DeviceType(raw_type)
    except (TypeError, ValueError):
        return DeviceType.LOCAL


def _runtime_device_id(device: Kind) -> str:
    spec = device.json.get("spec", {}) if isinstance(device.json, dict) else {}
    cloud_config = spec.get("cloudConfig")
    if not isinstance(cloud_config, dict):
        cloud_config = {}
    return str(
        spec.get("deviceId") or cloud_config.get("deviceId") or device.name or ""
    ).strip()


def _runtime_instance_id(device: Kind) -> str | None:
    spec = device.json.get("spec", {}) if isinstance(device.json, dict) else {}
    value = str(spec.get("runtimeInstanceId") or "").strip()
    return value or None


def _app_device_id(device: Kind) -> str | None:
    spec = device.json.get("spec", {}) if isinstance(device.json, dict) else {}
    value = str(spec.get("appDeviceId") or "").strip()
    return value or None


def _identity_from_device(device: Kind) -> RuntimeRouteIdentity | None:
    runtime_device_id = _runtime_device_id(device)
    if not runtime_device_id:
        return None
    return RuntimeRouteIdentity(
        logical_device_id=device.name,
        runtime_device_id=runtime_device_id,
        runtime_instance_id=_runtime_instance_id(device),
        device_type=_device_type(device),
        app_device_id=_app_device_id(device),
    )


def resolve_runtime_route_identity(
    db: Session,
    *,
    user_id: int,
    submitted_device_id: str,
) -> RuntimeRouteIdentity | None:
    """Resolve a logical, app exposure, or Runtime ID for one user."""

    base_filter = and_(
        Kind.user_id == user_id,
        Kind.kind == "Device",
        Kind.namespace == "default",
        Kind.is_active.is_(True),
    )
    logical_match = (
        db.query(Kind)
        .filter(and_(base_filter, Kind.name == submitted_device_id))
        .first()
    )
    if logical_match is not None:
        return _identity_from_device(logical_match)

    devices = db.query(Kind).filter(base_filter).all()
    app_matches = [
        device
        for device in devices
        if _app_device_id(device) == submitted_device_id
        and _device_type(device) in {DeviceType.APP, DeviceType.REMOTE}
    ]
    if len(app_matches) == 1:
        return _identity_from_device(app_matches[0])
    if len(app_matches) > 1:
        return None

    runtime_matches = [
        device
        for device in devices
        if _runtime_device_id(device) == submitted_device_id
    ]
    if len(runtime_matches) != 1:
        return None

    return _identity_from_device(runtime_matches[0])


class RuntimeRouteResolver:
    """Resolve current Runtime sockets without trusting client-side route IDs."""

    def __init__(
        self,
        session_factory: Callable[[], Session] | None = None,
    ) -> None:
        self._configured_session_factory = session_factory

    def _session_factory(self) -> Session:
        if self._configured_session_factory is not None:
            return self._configured_session_factory()
        from app.db.session import SessionLocal

        return SessionLocal()

    def _resolve_identity(
        self,
        user_id: int,
        submitted_device_id: str,
    ) -> RuntimeRouteIdentity | None:
        with self._session_factory() as db:
            return resolve_runtime_route_identity(
                db,
                user_id=user_id,
                submitted_device_id=submitted_device_id,
            )

    @trace_async(
        span_name="device.runtime_route.resolve",
        tracer_name="backend.device",
        extract_attributes=lambda self, **kwargs: {
            "device.user_id": str(kwargs.get("user_id", "")),
            "device.submitted_id": str(kwargs.get("submitted_device_id", "")),
        },
    )
    async def resolve(
        self,
        *,
        user_id: int,
        submitted_device_id: str,
    ) -> RuntimeRoute:
        """Resolve and validate one owned, online Runtime route."""

        identity = await asyncio.to_thread(
            self._resolve_identity,
            user_id,
            submitted_device_id,
        )
        if identity is None:
            raise RuntimeRouteError(
                "device_not_found",
                "Device not found or access denied",
                details={"deviceId": submitted_device_id},
            )

        online_info = await device_service.get_device_online_info(
            user_id,
            identity.runtime_device_id,
        )
        if not isinstance(online_info, dict):
            raise RuntimeRouteError(
                "device_offline",
                f"Device '{identity.logical_device_id}' is offline",
                retryable=True,
                details={"deviceId": identity.logical_device_id},
            )

        socket_id = online_info.get("socket_id")
        if not isinstance(socket_id, str) or not socket_id.strip():
            raise RuntimeRouteError(
                "runtime_route_missing",
                f"Device '{identity.logical_device_id}' has no current Runtime socket",
                retryable=True,
                details={"deviceId": identity.logical_device_id},
            )

        reported_instance_id = str(online_info.get("runtime_instance_id") or "").strip()
        if identity.runtime_instance_id and (
            not reported_instance_id
            or reported_instance_id != identity.runtime_instance_id
        ):
            raise RuntimeRouteError(
                "runtime_route_missing",
                f"Device '{identity.logical_device_id}' reported a stale Runtime route",
                retryable=True,
                details={"deviceId": identity.logical_device_id},
            )

        return RuntimeRoute(
            logical_device_id=identity.logical_device_id,
            runtime_device_id=identity.runtime_device_id,
            runtime_instance_id=identity.runtime_instance_id,
            device_type=identity.device_type,
            socket_id=socket_id.strip(),
            online_info=online_info,
            app_device_id=identity.app_device_id,
        )


runtime_route_resolver = RuntimeRouteResolver()
