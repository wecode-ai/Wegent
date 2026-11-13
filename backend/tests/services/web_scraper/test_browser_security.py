import asyncio
import json
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
            return_value={"targetInfo": {"targetId": "main", "type": "page"}}
        ),
        detach=AsyncMock(),
        on=Mock(),
    )
    return SimpleNamespace(
        browser=SimpleNamespace(
            new_browser_cdp_session=AsyncMock(return_value=session)
        ),
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
    child = SimpleNamespace(on=Mock(), send=AsyncMock())
    monkeypatch.setattr(module, "_TargetSession", lambda *args: child)
    guard = ChromiumRequestGuard(make_guard())
    guard._listen_for_targets(parent)

    await parent.on.call_args.args[1](
        {"sessionId": "child", "targetInfo": {"type": target_type, "targetId": "frame"}}
    )

    commands = [call.args[0] for call in child.send.await_args_list]
    assert commands == [
        "Fetch.enable",
        "Target.setAutoAttach",
        "Runtime.runIfWaitingForDebugger",
    ]
    assert child.send.await_args_list[1].args[1]["waitForDebuggerOnStart"] is True
