"""Keep remote MCP App retention bound to its authenticated socket owner."""

import asyncio
import logging
from dataclasses import dataclass
from typing import Any, Awaitable, Callable

from shared.telemetry.decorators import trace_async

logger = logging.getLogger(__name__)
Rpc = Callable[[], Awaitable[dict[str, Any]]]
Release = Callable[[int, str, dict[str, Any]], Awaitable[Any]]


@dataclass(frozen=True)
class RetainedApp:
    user_id: int
    device_id: str
    payload: dict[str, Any]


class McpAppOwnership:
    def __init__(self, release: Release) -> None:
        self._release = release
        self._owners: dict[str, dict[tuple[str, str, str, str], RetainedApp]] = {}

    @trace_async(span_name="wework.mcp_app.request", tracer_name=__name__)
    async def request(
        self, sid: str, user_id: int, device_id: str, params: dict[str, Any], rpc: Rpc
    ) -> dict[str, Any]:
        operation = params.get("method")
        address = params.get("address")
        address = address if isinstance(address, dict) else {}
        task_id = params.get("taskId") or address.get("taskId")
        call_id, session_id = params.get("callId"), params.get("sessionId")
        if operation not in ("retain", "release") or not all(
            isinstance(value, str) and value for value in (task_id, call_id, session_id)
        ):
            return await rpc()
        key = (device_id, task_id, call_id, session_id)
        owner = self._owners.setdefault(sid, {})
        app = RetainedApp(
            user_id,
            device_id,
            {
                "address": {"taskId": task_id, "deviceId": device_id},
                "callId": call_id,
                "sessionId": session_id,
                "method": "release",
            },
        )
        try:
            result = await rpc()
        except BaseException:
            if operation == "retain":
                await self._dispose(app)
            raise
        if operation == "release":
            if result.get("success") is not False:
                owner.pop(key, None)
        elif result.get("success") is False or self._owners.get(sid) is not owner:
            # A completed retain must not outlive a socket that closed while it ran.
            await self._dispose(app)
        else:
            owner[key] = app
        return result

    @trace_async(span_name="wework.mcp_app.disconnect", tracer_name=__name__)
    async def disconnect(self, sid: str) -> None:
        owner = self._owners.pop(sid, {})
        await asyncio.gather(*(self._dispose(app) for app in owner.values()))

    async def _dispose(self, app: RetainedApp) -> None:
        try:
            await self._release(app.user_id, app.device_id, app.payload)
        except Exception as error:
            logger.warning("MCP App owner cleanup failed: %s", type(error).__name__)
