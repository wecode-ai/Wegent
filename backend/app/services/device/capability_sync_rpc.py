# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Keep capability acknowledgements bound to a currently owned Runtime route."""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from socketio.exceptions import TimeoutError as SocketIOTimeoutError

from app.services.device.plugin_sync_protocol import supports_snapshot
from app.services.device.runtime_route import RuntimeRoute, runtime_route_resolver
from app.services.device_service import device_service
from shared.telemetry.decorators import trace_async

logger = logging.getLogger(__name__)
ROUTE_CHECK_INTERVAL_SECONDS = 1
MAX_ROUTE_CHANGES = 2


async def _changed_route(user_id: int, route: RuntimeRoute) -> RuntimeRoute:
    while True:
        await asyncio.sleep(ROUTE_CHECK_INTERVAL_SECONDS)
        online = await device_service.get_device_online_info(
            user_id, route.runtime_device_id
        )
        socket_id = online.get("socket_id") if isinstance(online, dict) else None
        if not socket_id or socket_id == route.socket_id:
            continue
        current = await runtime_route_resolver.resolve(
            user_id=user_id, submitted_device_id=route.logical_device_id
        )
        if (
            current.runtime_device_id != route.runtime_device_id
            or current.runtime_instance_id != route.runtime_instance_id
        ):
            raise ConnectionError("Device Runtime changed; retry synchronization")
        if current.socket_id != route.socket_id:
            return current


async def _call_on_routes(
    sio: Any,
    *,
    user_id: int,
    route: RuntimeRoute,
    payload: dict[str, Any],
    event: str,
    namespace: str,
    timeout_seconds: float,
) -> Any:
    for attempt in range(MAX_ROUTE_CHANGES + 1):
        call = asyncio.create_task(
            sio.call(
                event,
                payload,
                to=route.socket_id,
                namespace=namespace,
                timeout=timeout_seconds,
            )
        )
        changed = asyncio.create_task(_changed_route(user_id, route))
        try:
            await asyncio.wait((call, changed), return_when=asyncio.FIRST_COMPLETED)
            if call.done():
                return call.result()
            current = changed.result()
            if not payload.get("plugin_sync"):
                raise ConnectionError("Device reconnected; retry synchronization")
            if attempt == MAX_ROUTE_CHANGES:
                raise ConnectionError(
                    "Device connection is unstable; retry synchronization"
                )
            if payload.get("plugin_sync") and not supports_snapshot(
                current.online_info.get("runtime_features"), payload
            ):
                raise ConnectionError(
                    "Device plugin sync capability changed; retry synchronization"
                )
            logger.info(
                "Retrying capability acknowledgement after reconnect: user_id=%s "
                "device_id=%s generation=%s",
                user_id,
                route.logical_device_id,
                (payload.get("plugin_sync") or {}).get("generation"),
            )
            route = current
        finally:
            for task in (call, changed):
                task.cancel()
            await asyncio.gather(call, changed, return_exceptions=True)
    raise AssertionError("unreachable")


@trace_async("device.capability_sync.rpc", "backend.device")
async def call_capability_sync(
    sio: Any,
    *,
    user_id: int,
    route: RuntimeRoute,
    payload: dict[str, Any],
    event: str,
    namespace: str,
    timeout_seconds: float,
) -> Any:
    """Retry only a confirmed reconnect, preserving the payload and total deadline."""
    try:
        return await asyncio.wait_for(
            _call_on_routes(
                sio,
                user_id=user_id,
                route=route,
                payload=payload,
                event=event,
                namespace=namespace,
                timeout_seconds=timeout_seconds,
            ),
            timeout=timeout_seconds,
        )
    except (asyncio.TimeoutError, SocketIOTimeoutError) as exc:
        raise TimeoutError("Device capability sync acknowledgement timed out") from exc
