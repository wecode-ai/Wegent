# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Check Chromium requests before redirects are automatically continued.

Playwright's route API skips redirected requests. CDP Fetch interception is
therefore required for every page and out-of-process iframe target.
"""

import asyncio
import json
from collections.abc import Callable
from typing import Any
from weakref import WeakKeyDictionary, WeakValueDictionary

from app.services.web_scraper.security import WebScraperUrlGuard


class ChromiumProtocolError(RuntimeError):
    """Preserve safe protocol diagnostics without exposing request parameters."""

    def __init__(self, method: str, code: int | None) -> None:
        self.method = method
        self.code = code
        super().__init__(f"Chromium guard command failed: method={method} code={code}")


class _TargetSession:
    """Send CDP commands to an auto-attached, non-flattened child target."""

    def __init__(self, parent: Any, session_id: str) -> None:
        self._parent = parent
        self._session_id = session_id
        self._sequence = 0
        self._pending: dict[int, asyncio.Future[Any]] = {}
        self._methods: dict[int, str] = {}
        self._listeners: dict[str, list[Callable[..., Any]]] = {}
        parent.on("Target.receivedMessageFromTarget", self._receive)
        parent.on("Target.detachedFromTarget", self._detached)

    def on(self, event: str, listener: Callable[..., Any]) -> None:
        self._listeners.setdefault(event, []).append(listener)

    def remove_listener(self, event: str, listener: Callable[..., Any]) -> None:
        self._listeners[event].remove(listener)

    async def _detached(self, event: dict[str, Any]) -> None:
        if event["sessionId"] != self._session_id:
            return
        self._parent.remove_listener("Target.receivedMessageFromTarget", self._receive)
        self._parent.remove_listener("Target.detachedFromTarget", self._detached)
        for future in self._pending.values():
            future.cancel()
        self._listeners.clear()

    async def send(self, method: str, params: dict[str, Any] | None = None) -> Any:
        self._sequence += 1
        sequence = self._sequence
        future = asyncio.get_running_loop().create_future()
        self._pending[sequence] = future
        self._methods[sequence] = method
        try:
            await self._parent.send(
                "Target.sendMessageToTarget",
                {
                    "sessionId": self._session_id,
                    "message": json.dumps(
                        {"id": sequence, "method": method, "params": params or {}}
                    ),
                },
            )
            return await asyncio.wait_for(future, timeout=30)
        finally:
            self._pending.pop(sequence, None)
            self._methods.pop(sequence, None)

    async def _receive(self, event: dict[str, Any]) -> None:
        if event["sessionId"] != self._session_id:
            return
        message = json.loads(event["message"])
        if "id" in message:
            future = self._pending.get(message["id"])
            if future is not None and not future.done():
                if "error" in message:
                    future.set_exception(
                        ChromiumProtocolError(
                            self._methods[message["id"]],
                            message["error"].get("code"),
                        )
                    )
                else:
                    future.set_result(message.get("result", {}))
        else:
            for listener in tuple(self._listeners.get(message["method"], [])):
                await listener(message.get("params", {}))


class ChromiumRequestGuard:
    """Guard an owned page and pause its child iframe targets before requests."""

    def __init__(self, guard: WebScraperUrlGuard) -> None:
        self._guard = guard
        self._lock = asyncio.Lock()
        self._navigations: WeakValueDictionary[str, Any] = WeakValueDictionary()
        self._pages: WeakKeyDictionary[Any, str] = WeakKeyDictionary()

    async def begin_navigation(self, context: Any, page: Any, navigation: Any) -> None:
        async with self._lock:
            if target_id := self._pages.get(page):
                self._navigations[target_id] = navigation
                return
            session = await context.new_cdp_session(page)
            info = await session.send("Target.getTargetInfo")
            target = info["targetInfo"]
            self._navigations[target["targetId"]] = navigation
            await self._configure_target(session, target)
            self._pages[page] = target["targetId"]

    async def _configure_target(self, session: Any, info: dict[str, Any]) -> None:
        self._listen_for_targets(session)
        # Dedicated workers have no Fetch domain. Their requests are intercepted
        # by the creator page/iframe, as in Playwright's Chromium network manager.
        # Shared workers and out-of-process iframes do expose their own Fetch.
        if info["type"] != "worker":

            async def paused(request: dict[str, Any]) -> None:
                await self._route_request(session, info, request)

            session.on("Fetch.requestPaused", paused)
            await session.send(
                "Fetch.enable",
                {"patterns": [{"urlPattern": "*", "requestStage": "Request"}]},
            )
        await session.send("Target.setAutoAttach", self._auto_attach_params())

    @staticmethod
    def _auto_attach_params() -> dict[str, Any]:
        return {
            "autoAttach": True,
            "waitForDebuggerOnStart": True,
            "flatten": False,
            "filter": [
                {"type": "iframe"},
                {"type": "worker"},
                {"type": "shared_worker"},
                {"exclude": True},
            ],
        }

    def _listen_for_targets(self, parent: Any) -> None:
        async def attached(event: dict[str, Any]) -> None:
            session = _TargetSession(parent, event["sessionId"])
            await self._configure_target(session, event["targetInfo"])
            await session.send("Runtime.runIfWaitingForDebugger")

        parent.on("Target.attachedToTarget", attached)

    async def _route_request(
        self, session: Any, target: dict[str, Any], event: dict[str, Any]
    ) -> None:
        url = event["request"]["url"]
        request_id = {"requestId": event["requestId"]}
        if self._guard.is_allowed_fetch_url(url):
            await session.send("Fetch.continueRequest", request_id)
            return

        if (
            target["type"] == "page"
            and event["resourceType"] == "Document"
            and event["frameId"] == target["targetId"]
        ):
            navigation = self._navigations.get(target["targetId"])
            if navigation is not None:
                navigation.blocked_url = url
        await session.send(
            "Fetch.failRequest", {**request_id, "errorReason": "BlockedByClient"}
        )
