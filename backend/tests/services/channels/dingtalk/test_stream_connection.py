"""Stream lifecycle regressions; HTTP and WebSocket transports are mocked."""

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, Mock, call

import pytest
from dingtalk_stream import Credential
from websockets.exceptions import InvalidProxy

from app.services.channels.dingtalk import service, stream_client
from app.services.channels.dingtalk.service import DingTalkChannelProvider
from app.services.channels.dingtalk.stream_client import DingTalkStreamConnection


@pytest.fixture
def provider() -> DingTalkChannelProvider:
    channel = SimpleNamespace(
        id=1,
        name="test",
        channel_type="dingtalk",
        is_enabled=True,
        config={"client_id": "test", "client_secret": "test"},
        default_team_id=1,
    )
    result = DingTalkChannelProvider(channel)
    result._client = SimpleNamespace(connect_once=AsyncMock(), websocket=None)
    result._set_running(True)
    return result


@pytest.mark.asyncio
async def test_connection_errors_have_bounded_exponential_backoff(
    provider, monkeypatch
):
    provider._client.connect_once.side_effect = ConnectionError("offline")
    sleep = AsyncMock()
    monkeypatch.setattr(service.asyncio, "sleep", sleep)

    await provider._run_client()

    assert provider._client.connect_once.await_count == 11
    assert sleep.await_args_list == [
        call(delay) for delay in [1, 2, 4, 8, 16, 32, 60, 60, 60, 60]
    ]
    assert not provider.is_running
    assert "Max retries (10) exceeded: offline" == provider.last_error


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "error", [ImportError("missing SOCKS"), InvalidProxy("bad-proxy", "invalid scheme")]
)
async def test_configuration_errors_stop_without_retry(provider, monkeypatch, error):
    provider._client.connect_once.side_effect = error
    sleep = AsyncMock()
    monkeypatch.setattr(service.asyncio, "sleep", sleep)

    await provider._run_client()

    provider._client.connect_once.assert_awaited_once()
    sleep.assert_not_awaited()
    assert not provider.is_running
    assert str(error) in provider.last_error


@pytest.mark.asyncio
@pytest.mark.parametrize("during_backoff", [False, True])
async def test_cancellation_propagates_and_clears_running_state(
    provider, monkeypatch, during_backoff
):
    provider._client.connect_once.side_effect = (
        ConnectionError("offline") if during_backoff else asyncio.CancelledError()
    )
    monkeypatch.setattr(
        service.asyncio, "sleep", AsyncMock(side_effect=asyncio.CancelledError)
    )

    with pytest.raises(asyncio.CancelledError):
        await provider._run_client()

    assert not provider.is_running


@pytest.mark.asyncio
async def test_clean_remote_close_delays_reconnect(provider, monkeypatch):
    sleep = AsyncMock(side_effect=asyncio.CancelledError)
    monkeypatch.setattr(service.asyncio, "sleep", sleep)

    with pytest.raises(asyncio.CancelledError):
        await provider._run_client()

    sleep.assert_awaited_once_with(1.0)
    assert not provider.is_running


@pytest.mark.asyncio
async def test_stop_cleans_up_resources_after_retry_exhaustion(provider):
    provider._set_running(False)
    card_handler = SimpleNamespace(drain=AsyncMock())
    provider._card_handler = card_handler

    await provider.stop()

    card_handler.drain.assert_awaited_once()
    assert provider._client is None
    assert provider._card_handler is None
    assert provider._task is None


def test_running_worker_is_not_reported_as_connected(provider):
    assert not provider.get_status()["is_connected"]
    provider._client.websocket = object()
    assert provider.get_status()["is_connected"]


@pytest.fixture
def connection(monkeypatch) -> DingTalkStreamConnection:
    client = DingTalkStreamConnection(Credential("test", "test"))
    monkeypatch.setattr(client, "pre_start", Mock())
    monkeypatch.setattr(
        client,
        "open_connection",
        Mock(return_value={"endpoint": "wss://example.test", "ticket": "test"}),
    )
    return client


@pytest.mark.asyncio
async def test_websocket_failure_escapes_sdk_without_retry(connection, monkeypatch):
    transport = MagicMock()
    transport.__aenter__.side_effect = ImportError("missing SOCKS")
    connect = Mock(return_value=transport)
    monkeypatch.setattr(stream_client, "connect", connect)

    with pytest.raises(ImportError, match="missing SOCKS"):
        await connection.connect_once()

    connection.open_connection.assert_called_once()
    connect.assert_called_once_with("wss://example.test?ticket=test")


@pytest.mark.asyncio
async def test_failed_gateway_open_reaches_provider(connection):
    connection.open_connection.return_value = None

    with pytest.raises(ConnectionError, match="Stream endpoint"):
        await connection.connect_once()


@pytest.mark.asyncio
async def test_clean_close_finishes_received_callbacks(connection, monkeypatch):
    websocket = MagicMock()
    websocket.__aiter__.return_value = [
        '{"type": "CALLBACK", "headers": {"topic": "test"}}'
    ]
    websocket.send = AsyncMock()
    transport = MagicMock()
    transport.__aenter__.return_value = websocket
    monkeypatch.setattr(stream_client, "connect", Mock(return_value=transport))
    acknowledgement = SimpleNamespace(to_dict=lambda: {"code": 200})
    callback = AsyncMock(return_value=acknowledgement)
    connection.register_callback_handler("test", SimpleNamespace(raw_process=callback))

    await connection.connect_once()

    callback.assert_awaited_once()
    assert callback.await_args.args[0].headers.topic == "test"
    websocket.send.assert_awaited_once_with('{"code": 200}')
    assert connection.websocket is None


@pytest.mark.asyncio
async def test_cancelling_session_closes_socket_and_pending_handlers(
    connection, monkeypatch
):
    entered_handler = asyncio.Event()
    finished_handler = asyncio.Event()

    async def handle(message):
        assert message == {"type": "CALLBACK"}
        entered_handler.set()
        try:
            await asyncio.Future()
        finally:
            finished_handler.set()

    async def messages():
        yield '{"type": "CALLBACK"}'
        await asyncio.Future()

    websocket = MagicMock()
    websocket.__aiter__.side_effect = messages
    transport = MagicMock()
    transport.__aenter__.return_value = websocket
    monkeypatch.setattr(stream_client, "connect", Mock(return_value=transport))
    monkeypatch.setattr(connection, "background_task", handle)
    task = asyncio.create_task(connection.connect_once())
    await asyncio.wait_for(entered_handler.wait(), timeout=1)
    assert connection.websocket is websocket

    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task

    assert finished_handler.is_set()
    assert connection.websocket is None
    transport.__aexit__.assert_awaited_once()
