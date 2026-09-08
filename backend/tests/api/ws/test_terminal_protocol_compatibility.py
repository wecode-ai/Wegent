# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Legacy wire compatibility and terminal protocol negotiation regressions."""

from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest

from app.api.ws import device_namespace, terminal_namespace
from app.services.device.terminal_session_service import TerminalSessionRecord

LEGACY_ATTACH = {"session_id": "terminal-1"}
V2_ATTACH = {
    **LEGACY_ATTACH,
    "protocol_version": 2,
    "consumer_id": "consumer-1",
    "last_acked_sequence": 0,
}


@pytest.fixture
def relay(monkeypatch):
    record = TerminalSessionRecord(
        session_id="terminal-1",
        user_id=7,
        device_id="device-1",
        socket_id="device-sid",
        project_id=123,
        path="/repo",
        expires_at=datetime.now(timezone.utc) + timedelta(minutes=5),
    )
    session = {"user_id": 7, "token_exp": 9999999999}
    browser = terminal_namespace.TerminalNamespace()
    device = device_namespace.DeviceNamespace()
    sio = SimpleNamespace(
        call=AsyncMock(return_value={"success": True, "protocol_version": 2}),
        emit=AsyncMock(),
    )
    service = SimpleNamespace(
        authorize=AsyncMock(return_value=record),
        get=AsyncMock(return_value=record),
        delete=AsyncMock(),
        is_revoked=Mock(return_value=False),
        is_authorization_current=Mock(return_value=True),
    )
    for module in (terminal_namespace, device_namespace):
        monkeypatch.setattr(module, "get_sio", lambda: sio)
        monkeypatch.setattr(module, "terminal_session_service", service)
    monkeypatch.setattr(
        terminal_namespace,
        "device_service",
        SimpleNamespace(
            get_device_online_info=AsyncMock(return_value={"socket_id": "device-sid"})
        ),
    )
    monkeypatch.setattr(
        terminal_namespace.settings, "TERMINAL_PROTOCOL_V2_ENABLED", True
    )
    monkeypatch.setattr(browser, "get_session", AsyncMock(return_value=session))
    monkeypatch.setattr(browser, "save_session", AsyncMock())
    monkeypatch.setattr(browser, "enter_room", AsyncMock())
    monkeypatch.setattr(browser, "leave_room", AsyncMock())
    monkeypatch.setattr(
        device,
        "get_session",
        AsyncMock(return_value={"user_id": 7, "device_id": "device-1"}),
    )
    return SimpleNamespace(
        browser=browser, device=device, sio=sio, service=service, session=session
    )


@pytest.mark.parametrize("new_browser", [False, True])
@pytest.mark.parametrize("new_executor", [False, True])
async def test_new_backend_relays_old_and_new_endpoint_combinations(
    relay, new_browser, new_executor
):
    selected = 2 if new_browser and new_executor else 1
    executor_reply = {"success": True}
    if new_executor:
        executor_reply["protocol_version"] = selected
    relay.sio.call.return_value = executor_reply
    request = V2_ATTACH if new_browser else LEGACY_ATTACH

    result = await relay.browser.on_terminal_attach("browser-sid", request)

    assert result["protocol_version"] == selected
    assert relay.session["terminal_protocol_version"] == selected
    sent = relay.sio.call.await_args.args[1]
    assert sent == (
        V2_ATTACH if new_browser else {**LEGACY_ATTACH, "protocol_version": 1}
    )
    assert relay.session["terminal_consumer_id"] == (
        "consumer-1" if selected == 2 else None
    )

    output = {**LEGACY_ATTACH, "data": "legacy prompt\r\n"}
    if selected == 2:
        output.update(consumer_id="consumer-1", sequence=1, protocol_version=2)
    assert await relay.device.on_terminal_output("device-sid", output) == {
        "success": True
    }
    relay.sio.emit.assert_awaited_with(
        "terminal:output", output, room="terminal:terminal-1", namespace="/terminal"
    )

    for event, fields in (
        ("input", {"data": "pwd\n"}),
        ("resize", {"rows": 24, "cols": 80}),
    ):
        payload = {**LEGACY_ATTACH, **fields}
        result = await getattr(relay.browser, f"on_terminal_{event}")(
            "browser-sid", payload
        )
        assert result == {"success": True}
        if selected == 2:
            payload["consumer_id"] = "consumer-1"
        relay.sio.emit.assert_awaited_with(
            f"terminal:{event}", payload, to="device-sid", namespace="/local-executor"
        )

    relay.sio.call.reset_mock()
    ack = await relay.browser.on_terminal_ack(
        "browser-sid", {**LEGACY_ATTACH, "sequence": 1}
    )
    if selected == 1:
        assert ack == {"error": "Terminal ACK requires protocol v2"}
        relay.sio.call.assert_not_awaited()
    else:
        assert ack == {"success": True}
        assert relay.sio.call.await_args.args[1]["consumer_id"] == "consumer-1"

    assert await relay.browser.on_terminal_close("browser-sid", LEGACY_ATTACH) == {
        "success": True
    }
    close = dict(LEGACY_ATTACH)
    if selected == 2:
        close["consumer_id"] = "consumer-1"
    assert relay.sio.call.await_args.args == ("terminal:close", close)
    assert relay.session["terminal_protocol_version"] is None


@pytest.mark.parametrize(
    "version", [None, True, False, 0, 3, 1.0, 2.0, "1", "2", [], {}]
)
async def test_invalid_request_version_is_rejected_before_redis(relay, version):
    result = await relay.browser.on_terminal_attach(
        "browser-sid", {**V2_ATTACH, "protocol_version": version}
    )
    assert result == {"error": "Invalid terminal protocol_version"}
    relay.service.authorize.assert_not_awaited()
    relay.sio.call.assert_not_awaited()


@pytest.mark.parametrize("explicit_version", [False, True])
async def test_v2_fields_never_upgrade_a_legacy_request(relay, explicit_version):
    request = {**LEGACY_ATTACH, "consumer_id": "ignored", "last_acked_sequence": 9}
    if explicit_version:
        request["protocol_version"] = 1
    relay.sio.call.return_value = {"success": True, "protocol_version": 1}
    result = await relay.browser.on_terminal_attach("browser-sid", request)
    assert result["protocol_version"] == 1
    assert relay.sio.call.await_args.args[1] == {**LEGACY_ATTACH, "protocol_version": 1}


async def test_disabled_v2_offers_explicit_v1_without_consumer(relay, monkeypatch):
    monkeypatch.setattr(
        terminal_namespace.settings, "TERMINAL_PROTOCOL_V2_ENABLED", False
    )
    relay.sio.call.return_value = {"success": True, "protocol_version": 1}
    result = await relay.browser.on_terminal_attach("browser-sid", V2_ATTACH)
    assert result["protocol_version"] == 1
    assert relay.sio.call.await_args.args[1] == {**LEGACY_ATTACH, "protocol_version": 1}
    assert relay.session["terminal_consumer_id"] is None


async def test_disabled_v2_rejects_resume_before_contacting_executor(
    relay, monkeypatch
):
    monkeypatch.setattr(
        terminal_namespace.settings, "TERMINAL_PROTOCOL_V2_ENABLED", False
    )
    result = await relay.browser.on_terminal_attach(
        "browser-sid", {**V2_ATTACH, "last_acked_sequence": 8}
    )
    assert "Cannot downgrade terminal resume" in result["error"]
    relay.sio.call.assert_not_awaited()
    relay.service.authorize.assert_not_awaited()


@pytest.mark.parametrize(
    "reply", [{"success": True}, {"success": True, "protocol_version": 1}]
)
async def test_executor_cannot_downgrade_a_v2_resume(relay, reply):
    relay.sio.call.return_value = reply
    result = await relay.browser.on_terminal_attach(
        "browser-sid", {**V2_ATTACH, "last_acked_sequence": 8}
    )
    assert "Cannot downgrade terminal resume" in result["error"]
    relay.browser.save_session.assert_not_awaited()
    relay.browser.leave_room.assert_awaited_once_with(
        "browser-sid", "terminal:terminal-1"
    )


@pytest.mark.parametrize(
    "reply",
    [
        None,
        [],
        {},
        {"success": False},
        {"success": "true"},
        {"success": 1},
        {"success": True, "protocol_version": None},
        {"success": True, "protocol_version": True},
        {"success": True, "protocol_version": "2"},
        {"success": True, "protocol_version": 2.0},
        {"success": True, "protocol_version": 3},
    ],
)
async def test_malformed_executor_reply_does_not_complete_attach(relay, reply):
    relay.sio.call.return_value = reply
    result = await relay.browser.on_terminal_attach("browser-sid", V2_ATTACH)
    assert "error" in result
    relay.browser.save_session.assert_not_awaited()
    relay.browser.leave_room.assert_awaited_once()


async def test_executor_cannot_upgrade_legacy_offer(relay):
    result = await relay.browser.on_terminal_attach("browser-sid", LEGACY_ATTACH)
    assert result == {"error": "Invalid executor terminal protocol_version"}
    relay.browser.save_session.assert_not_awaited()


@pytest.mark.parametrize("first", [1, 2])
async def test_same_socket_session_cannot_change_protocol(relay, first):
    relay.sio.call.return_value = {"success": True, "protocol_version": first}
    request = V2_ATTACH if first == 2 else LEGACY_ATTACH
    assert (await relay.browser.on_terminal_attach("browser-sid", request))["success"]
    relay.sio.call.reset_mock()
    request = LEGACY_ATTACH if first == 2 else V2_ATTACH
    result = await relay.browser.on_terminal_attach("browser-sid", request)
    assert "Terminal protocol is pinned" in result["error"]
    assert relay.session["terminal_protocol_version"] == first
    relay.sio.call.assert_not_awaited()
    relay.browser.leave_room.assert_not_awaited()


async def test_existing_v2_attachment_survives_toggle_off(relay, monkeypatch):
    assert (await relay.browser.on_terminal_attach("browser-sid", V2_ATTACH))["success"]
    monkeypatch.setattr(
        terminal_namespace.settings, "TERMINAL_PROTOCOL_V2_ENABLED", False
    )
    result = await relay.browser.on_terminal_attach(
        "browser-sid", {**V2_ATTACH, "last_acked_sequence": 8}
    )
    assert result["protocol_version"] == 2
    assert relay.sio.call.await_args.args[1]["protocol_version"] == 2


async def test_consumer_bound_metadata_cannot_be_reattached_as_unversioned_v1(relay):
    assert (await relay.browser.on_terminal_attach("browser-sid", V2_ATTACH))["success"]
    relay.session.pop("terminal_protocol_version")
    relay.sio.call.reset_mock()
    result = await relay.browser.on_terminal_attach("browser-sid", LEGACY_ATTACH)
    assert "Terminal protocol is pinned" in result["error"]
    relay.sio.call.assert_not_awaited()
    relay.browser.leave_room.assert_not_awaited()


async def test_selected_v1_reconnect_remains_v1_when_v2_is_enabled(relay):
    relay.sio.call.return_value = {"success": True}
    assert (await relay.browser.on_terminal_attach("browser-sid", V2_ATTACH))[
        "protocol_version"
    ] == 1
    result = await relay.browser.on_terminal_attach(
        "browser-sid", {**LEGACY_ATTACH, "protocol_version": 1}
    )
    assert result["protocol_version"] == 1
    assert relay.sio.call.await_args.args[1] == {**LEGACY_ATTACH, "protocol_version": 1}


@pytest.mark.parametrize("version", [1, None, True, "2", 3])
async def test_v2_ack_cannot_override_the_bound_protocol(relay, version):
    assert (await relay.browser.on_terminal_attach("browser-sid", V2_ATTACH))["success"]
    relay.sio.call.reset_mock()
    result = await relay.browser.on_terminal_ack(
        "browser-sid", {**LEGACY_ATTACH, "protocol_version": version, "sequence": 1}
    )
    assert result == {"error": "Terminal protocol does not match attachment"}
    relay.sio.call.assert_not_awaited()


async def test_old_executor_reply_cannot_downgrade_existing_attachment(relay):
    assert (await relay.browser.on_terminal_attach("browser-sid", V2_ATTACH))["success"]
    relay.sio.call.return_value = {"success": True}
    result = await relay.browser.on_terminal_attach("browser-sid", V2_ATTACH)
    assert "Terminal protocol is pinned" in result["error"]
    assert relay.session["terminal_protocol_version"] == 2
    relay.browser.leave_room.assert_not_awaited()


@pytest.mark.parametrize(
    "event, fields",
    [
        ("ack", {"sequence": 1}),
        ("input", {"data": "x"}),
        ("resize", {"rows": 24, "cols": 80}),
        ("close", {}),
    ],
)
async def test_v2_controls_reject_mismatched_consumer(relay, event, fields):
    assert (await relay.browser.on_terminal_attach("browser-sid", V2_ATTACH))["success"]
    relay.sio.call.reset_mock()
    result = await getattr(relay.browser, f"on_terminal_{event}")(
        "browser-sid", {**LEGACY_ATTACH, **fields, "consumer_id": "other-consumer"}
    )
    assert result == {"error": "Terminal consumer does not match attachment"}
    relay.sio.call.assert_not_awaited()
    relay.sio.emit.assert_not_awaited()


@pytest.mark.parametrize("version", [None, 1])
@pytest.mark.parametrize(
    "event, fields",
    [
        ("output", {"data": "legacy\r\n"}),
        ("exit", {"exit_code": 0}),
        ("exit", {"exit_code": None, "error": "PTY closed"}),
    ],
)
async def test_complete_legacy_events_forward_without_v2_fields(
    relay, version, event, fields
):
    payload = {**LEGACY_ATTACH, **fields}
    if version is not None:
        payload["protocol_version"] = version
    result = await getattr(relay.device, f"on_terminal_{event}")("device-sid", payload)
    assert result == {"success": True}
    relay.sio.emit.assert_awaited_once_with(
        f"terminal:{event}", payload, room="terminal:terminal-1", namespace="/terminal"
    )
    if event == "exit":
        relay.service.delete.assert_awaited_once_with("terminal-1")


@pytest.mark.parametrize(
    "event, fields",
    [
        ("output", {"data": "x", "consumer_id": "c"}),
        ("output", {"data": "x", "sequence": 1}),
        ("output", {"data": "x", "protocol_version": 2}),
        (
            "output",
            {"data": "x", "protocol_version": 1, "sequence": 1, "consumer_id": "c"},
        ),
        ("output", {"data": "x", "sequence": 1, "consumer_id": None}),
        ("output", {"data": "x", "sequence": 1, "consumer_id": "c*"}),
        ("output", {"data": "x", "last_acked_sequence": 0}),
        ("output", {"data": "x", "protocol_version": True}),
        ("output", {"data": "x", "protocol_version": "1"}),
        ("output", {"data": "x", "protocol_version": None}),
        ("output", {"data": "x", "protocol_version": 3}),
        ("output", {"data": "x", "unknown": 1}),
        ("exit", {"exit_code": 0, "consumer_id": None}),
        ("exit", {"exit_code": 0, "consumer_id": ""}),
        ("exit", {"exit_code": 0, "sequence": 1}),
        ("exit", {"exit_code": 0, "protocol_version": 2}),
        ("exit", {"exit_code": 0, "protocol_version": 1, "consumer_id": "c"}),
        ("exit", {"exit_code": 0, "sequence": True, "consumer_id": "c"}),
        ("exit", {"exit_code": 0, "last_acked_sequence": 0}),
        ("exit", {"exit_code": "0"}),
        ("exit", {"exit_code": True}),
        ("exit", {"exit_code": 0, "error": 123}),
        ("exit", {}),
    ],
)
async def test_partial_or_malformed_v2_is_never_accepted_as_legacy(
    relay, event, fields
):
    result = await getattr(relay.device, f"on_terminal_{event}")(
        "device-sid", {**LEGACY_ATTACH, **fields}
    )
    assert "error" in result
    relay.service.get.assert_not_awaited()
    relay.service.delete.assert_not_awaited()
    relay.sio.emit.assert_not_awaited()
