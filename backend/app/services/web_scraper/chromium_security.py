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

BLOCK_WORKER_WEBSOCKETS = """(() => {
  const key = Symbol.for('wegent.scraper.workerWebSocketsBlocked');
  if (globalThis[key] === true) return true;
  const blocked = function () {
    throw new DOMException('Worker WebSockets are disabled by the scraper policy', 'SecurityError');
  };
  for (const name of ['WebSocket', 'WebSocketStream']) {
    let exposed = false;
    for (let owner = globalThis; owner; owner = Object.getPrototypeOf(owner)) {
      if (Object.getOwnPropertyDescriptor(owner, name)) {
        Object.defineProperty(owner, name, {
          value: blocked, writable: false, configurable: false
        });
        exposed = true;
      }
    }
    if (exposed) {
      Object.defineProperty(globalThis, name, {
        value: blocked, writable: false, configurable: false
      });
    }
  }
  Object.defineProperty(globalThis, key, {value: true, writable: false, configurable: false});
  return true;
})()"""


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
    """Guard owned pages and worker targets before they can send requests."""

    def __init__(self, guard: WebScraperUrlGuard) -> None:
        self._guard = guard
        self._lock = asyncio.Lock()
        self._navigations: WeakValueDictionary[str, Any] = WeakValueDictionary()
        self._pages: WeakKeyDictionary[Any, str] = WeakKeyDictionary()
        self._browser_session: Any | None = None
        self._browser_context_id: str | None = None
        self._browser_targets: set[str] = set()
        self._protected_workers: set[str] = set()
        self._context: Any | None = None

    async def begin_navigation(self, context: Any, page: Any, navigation: Any) -> None:
        async with self._lock:
            if target_id := self._pages.get(page):
                self._navigations[target_id] = navigation
                return
            session = await context.new_cdp_session(page)
            info = await session.send("Target.getTargetInfo")
            target = info["targetInfo"]
            await self._guard_browser_workers(context, target.get("browserContextId"))
            self._navigations[target["targetId"]] = navigation
            await self._configure_target(session, target)
            self._pages[page] = target["targetId"]

    async def _guard_browser_workers(
        self, context: Any, context_id: str | None
    ) -> None:
        if not context_id:
            raise RuntimeError("Protected browser context identity is required")
        if self._browser_session is not None:
            if context_id != self._browser_context_id:
                raise RuntimeError("Worker guard cannot span browser contexts")
            return
        self._browser_context_id = context_id
        self._context = context
        session = await context.browser.new_browser_cdp_session()
        self._browser_session = session
        initial: list[asyncio.Task[Any]] | None = []

        def attached(event: dict[str, Any]) -> asyncio.Task[Any]:
            task = asyncio.create_task(self._browser_worker_attached(event))
            if initial is not None:
                initial.append(task)
            return task

        session.on("Target.attachedToTarget", attached)

        async def closed(*args: Any) -> None:
            if self._browser_session is not session:
                return
            self._browser_session = None
            self._browser_targets.clear()
            self._protected_workers.clear()
            try:
                await session.detach()
            except Exception:
                if context.browser.is_connected():
                    raise

        context.on("close", closed)
        await session.send(
            "Target.setAutoAttach",
            {
                "autoAttach": True,
                "waitForDebuggerOnStart": True,
                "flatten": True,
                "filter": [
                    {"type": "shared_worker"},
                    {"type": "service_worker"},
                    {"exclude": True},
                ],
            },
        )
        await asyncio.gather(*initial)
        initial = None

    async def _browser_worker_attached(self, event: dict[str, Any]) -> None:
        session = self._browser_session
        info = event["targetInfo"]
        if info.get("browserContextId") != self._browser_context_id:
            # Detaching releases only this observer's startup barrier reference.
            await session.send(
                "Target.detachFromTarget", {"sessionId": event["sessionId"]}
            )
            return
        target_id = info["targetId"]
        if info["type"] == "service_worker":
            if not event["waitingForDebugger"]:
                await self._reject_late_worker()
            result = await session.send("Target.closeTarget", {"targetId": target_id})
            if result.get("success") is not True:
                raise RuntimeError("Unprotected worker could not be closed")
            return
        # Ignore only notifications for our own manual attachment. A worker
        # restart may reuse its target ID and must install the policy again.
        if target_id in self._browser_targets and not event["waitingForDebugger"]:
            return
        self._browser_targets.add(target_id)
        if not event["waitingForDebugger"]:
            await self._reject_late_worker()
        # Browser auto-attach must be flattened. Hold its barrier while adding
        # the message-based child session used by the same recursive guard.
        legacy = await session.send(
            "Target.attachToTarget", {"targetId": target_id, "flatten": False}
        )
        child = _TargetSession(session, legacy["sessionId"])
        await self._configure_target(child, info)
        self._protected_workers.add(target_id)
        await session.send("Target.detachFromTarget", {"sessionId": event["sessionId"]})

    async def _reject_late_worker(self) -> None:
        # A running worker may already retain native socket constructors. A late
        # injection cannot establish this context's security precondition.
        if self._context is not None:
            await self._context.close()
        raise RuntimeError("Worker started before scraper protection was installed")

    async def _configure_target(self, session: Any, info: dict[str, Any]) -> None:
        self._listen_for_targets(session)
        if info["type"] in {"worker", "shared_worker"}:
            await self._disable_worker_websockets(session)
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
    async def _disable_worker_websockets(session: Any) -> None:
        # CDP Fetch and Playwright's page-only WebSocket shim cannot guard worker
        # handshakes. Keep workers paused until this capability is disabled.
        await session.send("Runtime.enable")
        response = await session.send(
            "Runtime.evaluate",
            {"expression": BLOCK_WORKER_WEBSOCKETS, "returnByValue": True},
        )
        if (
            response.get("exceptionDetails")
            or response.get("result", {}).get("value") is not True
        ):
            raise RuntimeError("Worker WebSocket protection could not be installed")

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
            info = event["targetInfo"]
            if (
                info["type"] in {"worker", "shared_worker"}
                and not event["waitingForDebugger"]
                and info["targetId"] not in self._protected_workers
            ):
                await self._reject_late_worker()
            session = _TargetSession(parent, event["sessionId"])
            await self._configure_target(session, info)
            if info["type"] in {"worker", "shared_worker"}:
                self._protected_workers.add(info["targetId"])
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
