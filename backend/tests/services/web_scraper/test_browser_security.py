import asyncio
import json
import subprocess
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock, Mock

import pytest

from app.services.web_scraper.browser_security import (
    BrowserNavigation,
    configure_crawler_security,
    install_browser_guard,
)
from app.services.web_scraper.chromium_security import (
    ChromiumRequestGuard,
    _TargetSession,
)
from app.services.web_scraper.models import ERROR_SSRF_BLOCKED
from app.services.web_scraper.security import (
    WebScraperSecurityError,
    WebScraperUrlGuard,
)


class Page:
    pass


def make_context() -> SimpleNamespace:
    session = SimpleNamespace(
        send=AsyncMock(
            return_value={
                "targetInfo": {
                    "targetId": "main",
                    "type": "page",
                    "browserContextId": "owned",
                }
            }
        ),
        detach=AsyncMock(),
        on=Mock(),
    )
    return SimpleNamespace(
        browser=SimpleNamespace(
            new_browser_cdp_session=AsyncMock(
                return_value=SimpleNamespace(
                    on=Mock(), send=AsyncMock(), detach=AsyncMock()
                )
            )
        ),
        on=Mock(),
        close=AsyncMock(),
        route=AsyncMock(),
        new_cdp_session=AsyncMock(return_value=session),
        route_web_socket=AsyncMock(),
    )


def make_guard() -> WebScraperUrlGuard:
    return WebScraperUrlGuard()


@pytest.mark.parametrize("allowed", [False, True])
@pytest.mark.parametrize("resource", ["Document", "Image"])
async def test_requests_checked_before_network(allowed: bool, resource: str) -> None:
    context = make_context()
    session = context.new_cdp_session.return_value
    handlers = {}
    session.on.side_effect = lambda event, callback: handlers.update({event: callback})
    guard = await install_browser_guard(context, make_guard())
    page = Page()
    await guard.begin_navigation(context, page, BrowserNavigation())
    session.send.reset_mock()
    event = {
        "requestId": "req",
        "request": {"url": "http://93.184.216.34" if allowed else "http://127.0.0.1"},
        "frameId": "main",
        "resourceType": resource,
    }

    await handlers["Fetch.requestPaused"](event)

    if allowed:
        session.send.assert_awaited_once_with(
            "Fetch.continueRequest", {"requestId": "req"}
        )
    else:
        session.send.assert_awaited_once_with(
            "Fetch.failRequest", {"requestId": "req", "errorReason": "BlockedByClient"}
        )


@pytest.mark.parametrize(
    ("target_type", "resource", "frame_id", "fails_page"),
    [
        ("page", "Document", "main", True),
        ("page", "Document", "child", False),
        ("page", "Image", "main", False),
        ("iframe", "Document", "main", False),
    ],
)
async def test_denial_distinguishes_main_navigation(
    target_type: str, resource: str, frame_id: str, fails_page: bool
) -> None:
    context = make_context()
    guard = ChromiumRequestGuard(make_guard())
    navigation = BrowserNavigation()
    await guard.begin_navigation(context, Page(), navigation)

    await guard._route_request(
        SimpleNamespace(send=AsyncMock()),
        {"type": target_type, "targetId": "main"},
        {
            "requestId": "req",
            "request": {"url": "http://127.0.0.1/?secret=token"},
            "resourceType": resource,
            "frameId": frame_id,
        },
    )

    if fails_page:
        with pytest.raises(WebScraperSecurityError) as error:
            navigation.raise_if_blocked()
        assert error.value.error_code == ERROR_SSRF_BLOCKED
        assert "secret=token" not in error.value.message
    else:
        navigation.raise_if_blocked()


async def test_installation_is_idempotent_on_reused_context() -> None:
    context = make_context()
    installed = await asyncio.gather(
        *(install_browser_guard(context, make_guard()) for _ in range(3))
    )

    assert installed[0] is installed[1] is installed[2]
    context.route.assert_awaited_once()
    context.route_web_socket.assert_awaited_once()


async def test_reused_page_updates_navigation_without_adding_handlers() -> None:
    context = make_context()
    installed = await install_browser_guard(context, make_guard())
    page = Page()
    first, second = BrowserNavigation(), BrowserNavigation()

    await installed.begin_navigation(context, page, first)
    await installed.begin_navigation(context, page, second)

    context.new_cdp_session.assert_awaited_once()
    handlers = {
        call.args[0]: call.args[1]
        for call in context.new_cdp_session.return_value.on.call_args_list
    }
    await handlers["Fetch.requestPaused"](
        {
            "requestId": "r",
            "request": {"url": "http://127.0.0.1"},
            "frameId": "main",
            "resourceType": "Document",
        }
    )
    first.raise_if_blocked()
    with pytest.raises(WebScraperSecurityError):
        second.raise_if_blocked()


async def test_unowned_popup_is_aborted_before_its_first_request() -> None:
    context = make_context()
    installed = await install_browser_guard(context, make_guard())
    page = Page()
    await installed.begin_navigation(context, page, BrowserNavigation())
    route = SimpleNamespace(continue_=AsyncMock(), abort=AsyncMock())
    request = SimpleNamespace(frame=SimpleNamespace(page=Page()))

    await context.route.call_args.args[1](route, request)

    route.abort.assert_awaited_once()
    route.continue_.assert_not_awaited()


async def test_owned_page_is_admitted_to_cdp_checks() -> None:
    context = make_context()
    installed = await install_browser_guard(context, make_guard())
    page = Page()
    await installed.begin_navigation(context, page, BrowserNavigation())
    route = SimpleNamespace(continue_=AsyncMock(), abort=AsyncMock())

    await context.route.call_args.args[1](
        route, SimpleNamespace(frame=SimpleNamespace(page=page))
    )

    route.continue_.assert_awaited_once()
    route.abort.assert_not_awaited()


@pytest.mark.parametrize("allowed", [False, True])
async def test_websocket_connects_only_after_validation(allowed: bool) -> None:
    context = make_context()
    await install_browser_guard(context, make_guard())
    websocket = SimpleNamespace(
        url="ws://93.184.216.34/socket" if allowed else "ws://127.0.0.1/socket",
        connect_to_server=Mock(),
        close=AsyncMock(),
    )

    await context.route_web_socket.call_args.args[1](websocket)

    if allowed:
        websocket.connect_to_server.assert_called_once()
        websocket.close.assert_not_awaited()
    else:
        websocket.close.assert_awaited_once()
        websocket.connect_to_server.assert_not_called()


async def test_crawler_hooks_guard_context_before_navigation() -> None:
    hooks: dict[str, Any] = {}
    context = make_context()
    manager = SimpleNamespace(setup_context=AsyncMock(), default_context=object())
    crawler = SimpleNamespace(
        crawler_strategy=SimpleNamespace(
            set_hook=lambda name, hook: hooks.update({name: hook}),
            browser_manager=manager,
        )
    )
    browser = SimpleNamespace(new_context=AsyncMock(return_value=context))
    configure_crawler_security(crawler, make_guard())

    await hooks["on_browser_created"](browser)
    browser.new_context.assert_awaited_once_with(service_workers="block")
    assert manager.default_context is context
    page = Page()
    assert (
        await hooks["on_page_context_created"](
            page,
            context=context,
            config=SimpleNamespace(_wegent_navigation=BrowserNavigation()),
        )
        is page
    )
    context.new_cdp_session.assert_awaited_once_with(page)


async def test_child_session_commands_and_events_are_demultiplexed() -> None:
    listeners: list[Any] = []

    async def send(method: str, params: dict[str, Any]) -> None:
        command = json.loads(params["message"])
        for listener in listeners:
            await listener(
                {
                    "sessionId": params["sessionId"],
                    "message": json.dumps(
                        {"id": command["id"], "result": {"ok": True}}
                    ),
                }
            )

    def on(event: str, listener: Any) -> None:
        if event == "Target.receivedMessageFromTarget":
            listeners.append(listener)

    parent = SimpleNamespace(send=send, on=on)
    first = _TargetSession(parent, "page-session")
    second = _TargetSession(parent, "iframe-session")

    assert await first.send("Fetch.enable") == {"ok": True}
    assert await second.send("Fetch.enable") == {"ok": True}
    event = AsyncMock()
    first.on("Fetch.requestPaused", event)
    await first._receive(
        {
            "sessionId": "page-session",
            "message": json.dumps(
                {"method": "Fetch.requestPaused", "params": {"requestId": "r"}}
            ),
        }
    )
    event.assert_awaited_once_with({"requestId": "r"})


@pytest.mark.parametrize("target_type", ["iframe", "worker", "shared_worker"])
async def test_child_target_is_guarded_before_execution(
    monkeypatch: pytest.MonkeyPatch, target_type: str
) -> None:
    import app.services.web_scraper.chromium_security as module

    parent = SimpleNamespace(on=Mock())
    child = SimpleNamespace(
        on=Mock(), send=AsyncMock(return_value={"result": {"value": True}})
    )
    monkeypatch.setattr(module, "_TargetSession", lambda *args: child)
    guard = ChromiumRequestGuard(make_guard())
    guard._listen_for_targets(parent)

    await parent.on.call_args.args[1](
        {
            "sessionId": "child",
            "waitingForDebugger": True,
            "targetInfo": {"type": target_type, "targetId": "frame"},
        }
    )

    commands = [call.args[0] for call in child.send.await_args_list]
    expected = ["Target.setAutoAttach", "Runtime.runIfWaitingForDebugger"]
    if target_type != "worker":
        expected.insert(0, "Fetch.enable")
    if target_type in {"worker", "shared_worker"}:
        expected[:0] = ["Runtime.enable", "Runtime.evaluate"]
    assert commands == expected
    attach = next(
        call
        for call in child.send.await_args_list
        if call.args[0] == "Target.setAutoAttach"
    )
    assert attach.args[1]["waitForDebuggerOnStart"] is True


@pytest.mark.parametrize("target_type", ["worker", "shared_worker"])
async def test_worker_socket_capabilities_are_disabled_before_execution(
    monkeypatch: pytest.MonkeyPatch, target_type: str
) -> None:
    import app.services.web_scraper.chromium_security as module

    parent = SimpleNamespace(on=Mock())
    child = SimpleNamespace(
        on=Mock(), send=AsyncMock(return_value={"result": {"value": True}})
    )
    monkeypatch.setattr(module, "_TargetSession", lambda *args: child)
    ChromiumRequestGuard(make_guard())._listen_for_targets(parent)

    await parent.on.call_args.args[1](
        {
            "sessionId": "child",
            "waitingForDebugger": True,
            "targetInfo": {"type": target_type, "targetId": "w"},
        }
    )

    commands = [call.args[0] for call in child.send.await_args_list]
    assert "Runtime.evaluate" in commands
    assert commands.index("Runtime.enable") < commands.index("Runtime.evaluate")
    assert commands.index("Runtime.evaluate") < commands.index(
        "Runtime.runIfWaitingForDebugger"
    )
    evaluation = next(
        call.args[1]
        for call in child.send.await_args_list
        if call.args[0] == "Runtime.evaluate"
    )
    assert evaluation["returnByValue"] is True


@pytest.mark.parametrize(
    "response",
    [{"exceptionDetails": {"text": "blocked"}}, {"result": {"value": False}}],
)
async def test_worker_is_not_resumed_when_socket_policy_is_not_installed(
    monkeypatch: pytest.MonkeyPatch, response: dict[str, Any]
) -> None:
    import app.services.web_scraper.chromium_security as module

    async def send(method: str, params: Any = None) -> dict[str, Any]:
        return response if method == "Runtime.evaluate" else {}

    parent = SimpleNamespace(on=Mock())
    child = SimpleNamespace(on=Mock(), send=AsyncMock(side_effect=send))
    monkeypatch.setattr(module, "_TargetSession", lambda *args: child)
    ChromiumRequestGuard(make_guard())._listen_for_targets(parent)

    with pytest.raises(RuntimeError, match="Worker WebSocket protection"):
        await parent.on.call_args.args[1](
            {
                "sessionId": "child",
                "waitingForDebugger": True,
                "targetInfo": {"type": "worker", "targetId": "w"},
            }
        )
    assert "Runtime.runIfWaitingForDebugger" not in [
        call.args[0] for call in child.send.await_args_list
    ]


async def test_child_command_error_keeps_method_and_code() -> None:
    listeners = {}

    async def send(method: str, params: dict[str, Any]) -> None:
        command = json.loads(params["message"])
        await listeners["Target.receivedMessageFromTarget"](
            {
                "sessionId": params["sessionId"],
                "message": json.dumps(
                    {
                        "id": command["id"],
                        "error": {
                            "code": -32601,
                            "message": "'Fetch.enable' wasn't found",
                        },
                    }
                ),
            }
        )

    parent = SimpleNamespace(
        send=send, on=lambda event, handler: listeners.update({event: handler})
    )
    child = _TargetSession(parent, "worker-session")
    with pytest.raises(RuntimeError) as error:
        await child.send("Fetch.enable")
    assert getattr(error.value, "method", None) == "Fetch.enable"
    assert getattr(error.value, "code", None) == -32601
    assert "Fetch.enable" in str(error.value)


async def test_dedicated_worker_uses_creator_request_interception_before_running() -> (
    None
):
    """Chromium delivers dedicated-worker Fetch pauses on its creator target."""
    context = make_context()
    session = context.new_cdp_session.return_value
    handlers: dict[str, Any] = {}
    session.on.side_effect = lambda event, handler: handlers.update({event: handler})
    commands: list[tuple[str, str]] = []

    async def send(method: str, params: dict | None = None) -> dict:
        if method == "Target.getTargetInfo":
            return {
                "targetInfo": {
                    "targetId": "main",
                    "type": "page",
                    "browserContextId": "owned",
                }
            }
        if method == "Target.sendMessageToTarget":
            command = json.loads(params["message"])
            commands.append(("worker", command["method"]))
            reply = {"id": command["id"], "result": {}}
            if command["method"] == "Runtime.evaluate":
                reply["result"] = {"result": {"value": True}}
            if command["method"] == "Fetch.enable":
                reply = {"id": command["id"], "error": {"code": -32601}}
            await handlers["Target.receivedMessageFromTarget"](
                {
                    "sessionId": params["sessionId"],
                    "message": json.dumps(reply),
                }
            )
        else:
            commands.append(("page", method))
        return {}

    session.send.side_effect = send
    installed = await install_browser_guard(context, WebScraperUrlGuard())
    page = Page()
    await installed.begin_navigation(context, page, BrowserNavigation())
    await handlers["Target.attachedToTarget"](
        {
            "sessionId": "dedicated",
            "waitingForDebugger": True,
            "targetInfo": {"targetId": "worker", "type": "worker"},
        }
    )
    assert ("worker", "Fetch.enable") not in commands
    assert commands[-2:] == [
        ("worker", "Target.setAutoAttach"),
        ("worker", "Runtime.runIfWaitingForDebugger"),
    ]
    for url in ("http://93.184.216.34/public", "http://127.0.0.1/private"):
        await handlers["Fetch.requestPaused"](
            {
                "requestId": url,
                "request": {"url": url},
                "resourceType": "Fetch",
            }
        )
    assert commands[-2:] == [
        ("page", "Fetch.continueRequest"),
        ("page", "Fetch.failRequest"),
    ]


def test_worker_socket_policy_cannot_be_replaced_or_recovered_from_prototypes() -> None:
    from app.services.web_scraper.chromium_security import BLOCK_WORKER_WEBSOCKETS

    program = r"""
const assert = require('node:assert/strict');
const vm = require('node:vm');
const context = vm.createContext({DOMException});
vm.runInContext(`
  globalThis.WebSocket = function () { throw new Error('native-called'); };
  Object.setPrototypeOf(globalThis, {
    WebSocketStream: function () { throw new Error('native-stream-called'); }
  });
  globalThis.fetch = () => 'http-is-unchanged';
`, context);
assert.equal(vm.runInContext(POLICY, context), true);
assert.equal(vm.runInContext(POLICY, context), true);
vm.runInContext(`
  const blocked = globalThis.WebSocket;
  if (Reflect.set(globalThis, 'WebSocket', function () {})) throw new Error('replace');
  if (Reflect.deleteProperty(globalThis, 'WebSocket')) throw new Error('delete');
  if (globalThis.WebSocket !== blocked) throw new Error('changed');
  for (let owner = globalThis; owner; owner = Object.getPrototypeOf(owner)) {
    for (const name of ['WebSocket', 'WebSocketStream']) {
      const descriptor = Object.getOwnPropertyDescriptor(owner, name);
      if (!descriptor) continue;
      if (descriptor.writable || descriptor.configurable) throw new Error('mutable');
      try {
        new descriptor.value('ws://127.0.0.1/private');
        throw new Error('connected');
      } catch (error) {
        if (error.name !== 'SecurityError') throw error;
      }
    }
  }
  if (fetch() !== 'http-is-unchanged') throw new Error('http-changed');
`, context);
const absent = vm.createContext({DOMException, WebSocket: function () {}});
vm.runInContext(POLICY, absent);
assert.equal(vm.runInContext("'WebSocketStream' in globalThis", absent), false);
"""
    result = subprocess.run(
        [
            "node",
            "-e",
            "const POLICY = " + json.dumps(BLOCK_WORKER_WEBSOCKETS) + ";" + program,
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr


async def test_browser_worker_observer_is_context_scoped_and_closed_once(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import app.services.web_scraper.chromium_security as module

    context = make_context()
    root = context.browser.new_browser_cdp_session.return_value
    root.send.return_value = {"sessionId": "manual"}
    child = SimpleNamespace(
        on=Mock(), send=AsyncMock(return_value={"result": {"value": True}})
    )
    factory = Mock(return_value=child)
    monkeypatch.setattr(module, "_TargetSession", factory)
    guard = ChromiumRequestGuard(make_guard())
    await guard.begin_navigation(context, Page(), BrowserNavigation())
    await guard.begin_navigation(context, Page(), BrowserNavigation())
    context.browser.new_browser_cdp_session.assert_awaited_once()
    listener = root.on.call_args.args[1]
    await listener(
        {
            "sessionId": "unowned",
            "waitingForDebugger": True,
            "targetInfo": {
                "type": "shared_worker",
                "targetId": "other",
                "browserContextId": "other",
            },
        }
    )
    factory.assert_not_called()
    root.send.assert_awaited_with("Target.detachFromTarget", {"sessionId": "unowned"})
    root.send.reset_mock()
    await listener(
        {
            "sessionId": "automatic",
            "waitingForDebugger": True,
            "targetInfo": {
                "type": "shared_worker",
                "targetId": "w",
                "browserContextId": "owned",
            },
        }
    )
    factory.assert_called_once_with(root, "manual")
    commands = [call.args[0] for call in child.send.await_args_list]
    assert commands == [
        "Runtime.enable",
        "Runtime.evaluate",
        "Fetch.enable",
        "Target.setAutoAttach",
    ]
    root.send.assert_awaited_with("Target.detachFromTarget", {"sessionId": "automatic"})
    assert "Runtime.runIfWaitingForDebugger" not in commands
    await context.on.call_args.args[1]()
    await context.on.call_args.args[1]()
    root.detach.assert_awaited_once()


@pytest.mark.parametrize("success", [True, False])
async def test_owned_service_worker_is_closed_without_resume(success: bool) -> None:
    context = make_context()
    guard = ChromiumRequestGuard(make_guard())
    await guard.begin_navigation(context, Page(), BrowserNavigation())
    root = context.browser.new_browser_cdp_session.return_value
    root.send.reset_mock()
    root.send.return_value = {"success": success}
    event = {
        "sessionId": "automatic",
        "waitingForDebugger": True,
        "targetInfo": {
            "type": "service_worker",
            "targetId": "w",
            "browserContextId": "owned",
        },
    }
    listener = root.on.call_args.args[1]
    if success:
        await listener(event)
    else:
        with pytest.raises(RuntimeError, match="could not be closed"):
            await listener(event)
    root.send.assert_awaited_once_with("Target.closeTarget", {"targetId": "w"})


@pytest.mark.parametrize("kind", ["worker", "shared_worker"])
async def test_already_running_owned_worker_rejects_its_context(kind: str) -> None:
    context = make_context()
    guard = ChromiumRequestGuard(make_guard())
    await guard.begin_navigation(context, Page(), BrowserNavigation())
    event = {
        "sessionId": "late",
        "waitingForDebugger": False,
        "targetInfo": {"type": kind, "targetId": "w", "browserContextId": "owned"},
    }
    if kind == "shared_worker":
        root = context.browser.new_browser_cdp_session.return_value
        root.send.reset_mock()
        listener = root.on.call_args.args[1]
    else:
        parent = SimpleNamespace(on=Mock())
        guard._listen_for_targets(parent)
        listener = parent.on.call_args.args[1]
    with pytest.raises(RuntimeError, match="Worker started before scraper protection"):
        await listener(event)
    context.close.assert_awaited_once()


async def test_browser_worker_configuration_failure_keeps_startup_barrier(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import app.services.web_scraper.chromium_security as module

    context = make_context()
    guard = ChromiumRequestGuard(make_guard())
    await guard.begin_navigation(context, Page(), BrowserNavigation())
    root = context.browser.new_browser_cdp_session.return_value
    root.send.reset_mock()
    root.send.return_value = {"sessionId": "manual"}
    child = SimpleNamespace(
        on=Mock(), send=AsyncMock(return_value={"exceptionDetails": {}})
    )
    monkeypatch.setattr(module, "_TargetSession", lambda *args: child)
    with pytest.raises(RuntimeError, match="Worker WebSocket protection"):
        await root.on.call_args.args[1](
            {
                "sessionId": "automatic",
                "waitingForDebugger": True,
                "targetInfo": {
                    "type": "shared_worker",
                    "targetId": "w",
                    "browserContextId": "owned",
                },
            }
        )
    assert "Target.detachFromTarget" not in [
        call.args[0] for call in root.send.await_args_list
    ]
