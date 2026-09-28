"""Token refresh and card I/O share cancellable deadlines, without SDK threads."""

import asyncio
import json
import time
from types import SimpleNamespace
from unittest.mock import Mock

import httpx
import pytest

from app.services.channels.dingtalk import card_transport
from app.services.channels.dingtalk.card import DingTalkMarkdownCard
from app.services.channels.dingtalk.card_transport import DingTalkCardTransport
from tests.services.channels.dingtalk.test_card_delivery import cached_client


@pytest.mark.asyncio
async def test_refreshes_shared_token_cache_without_sdk_io(httpx_mock):
    client = cached_client()
    client._access_token["expireTime"] = 0
    client.get_access_token = Mock(side_effect=AssertionError("blocking SDK called"))
    transport = DingTalkCardTransport(client)
    httpx_mock.add_response(json={"accessToken": "new-token", "expireIn": 7200})
    httpx_mock.add_response(json={"success": True}, is_reusable=True)
    try:
        await transport.request("PUT", "streaming", {})
        await transport.request("PUT", "streaming", {})
        requests = httpx_mock.get_requests()
        assert len(requests) == 3
        assert requests[0].url.path == "/v1.0/oauth2/accessToken"
        assert json.loads(requests[0].content) == {
            "appKey": "robot-a",
            "appSecret": "test-secret",
        }
        assert all(
            r.headers["x-acs-dingtalk-access-token"] == "new-token"
            for r in requests[1:]
        )
        assert client._access_token["expireTime"] > time.time() + 6800
        client.get_access_token.assert_not_called()
    finally:
        await transport.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("phase", ["token", "card"])
@pytest.mark.parametrize("stop", ["cancel", "timeout"])
async def test_cancellation_and_deadline_stop_actual_http(
    monkeypatch, httpx_mock, phase, stop
):
    started, stopped, release = asyncio.Event(), asyncio.Event(), asyncio.Event()

    async def blocked(request):
        started.set()
        try:
            await release.wait()
            raise AssertionError("cancelled HTTP request resumed")
        finally:
            stopped.set()

    client = cached_client()
    if phase == "token":
        client._access_token = None
    httpx_mock.add_callback(blocked)
    monkeypatch.setattr(
        card_transport, "CARD_REQUEST_TIMEOUT", 0.05 if stop == "timeout" else 5
    )
    transport = DingTalkCardTransport(client)
    pending = asyncio.create_task(transport.request("PUT", "streaming", {}))
    try:
        await asyncio.wait_for(started.wait(), 1)
        if stop == "cancel":
            pending.cancel()
        with pytest.raises(
            asyncio.CancelledError if stop == "cancel" else TimeoutError
        ):
            await pending
        assert stopped.is_set()
        assert len(httpx_mock.get_requests()) == 1
        release.set()
    finally:
        pending.cancel()
        await asyncio.gather(pending, return_exceptions=True)
        await transport.close()


@pytest.mark.asyncio
async def test_deadline_includes_retry_backoff(monkeypatch, httpx_mock):
    monkeypatch.setattr(card_transport, "CARD_REQUEST_TIMEOUT", 0.02)
    httpx_mock.add_response(status_code=503, json={})
    transport = DingTalkCardTransport(cached_client())
    try:
        with pytest.raises(TimeoutError):
            await transport.request("PUT", "streaming", {})
        assert len(httpx_mock.get_requests()) == 1
    finally:
        await transport.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("conversation_type", ["1", "2"])
async def test_builtin_creation_preserves_sdk_template_and_delivery(
    httpx_mock, conversation_type
):
    httpx_mock.add_response(json={}, is_reusable=True)
    message = SimpleNamespace(
        conversation_type=conversation_type,
        conversation_id="group-a",
        sender_staff_id="staff-a",
        hosting_context=SimpleNamespace(user_id="host-user", nick="test"),
    )
    card = DingTalkMarkdownCard(cached_client(), message)
    try:
        await card.ai_start()
        await card.ai_start()
        requests = httpx_mock.get_requests()
        assert len(requests) == 2
        create, deliver = [json.loads(r.content) for r in requests]
        assert create["cardTemplateId"] == card.card_template_id
        assert create["cardData"]["cardParamMap"] == {"flowStatus": "1"}
        assert create["outTrackId"] == deliver["outTrackId"] == card.card_instance_id
        key = (
            "imGroupOpenDeliverModel"
            if conversation_type == "2"
            else "imRobotOpenDeliverModel"
        )
        assert json.loads(deliver[key]["extension"]["hostingRepliedContext"]) == {
            "userId": "host-user"
        }
        assert deliver["openSpaceId"] == (
            "dtv1.card//IM_GROUP.group-a"
            if conversation_type == "2"
            else "dtv1.card//IM_ROBOT.staff-a"
        )
    finally:
        await card.close()


@pytest.mark.asyncio
async def test_builtin_delivery_retry_does_not_recreate_card(httpx_mock):
    httpx_mock.add_response(json={})
    httpx_mock.add_response(status_code=403, json={})
    httpx_mock.add_response(json={})
    card = DingTalkMarkdownCard(
        cached_client(),
        SimpleNamespace(
            conversation_type="1",
            sender_staff_id="staff-a",
            hosting_context=None,
        ),
    )
    try:
        with pytest.raises(RuntimeError, match="HTTP 403"):
            await card.ai_start()
        assert card.card_instance_id is None
        await card.ai_start()
        requests = httpx_mock.get_requests()
        assert requests[1].content == requests[2].content
        assert requests[2].url.path.endswith("instances/deliver")
    finally:
        await card.close()
