"""Exercise actual SDK card transitions with mocked HTTP responses."""

from types import SimpleNamespace
from unittest.mock import Mock

import pytest
import requests
from dingtalk_stream import ChatbotMessage
from dingtalk_stream.card_replier import AICardStatus

from app.services.channels.dingtalk.card_adapter import TemplateChatCardAdapter
from app.services.channels.dingtalk.emitter import StreamingResponseEmitter
from tests.services.channels.dingtalk.test_chat_card import binding, cache, config


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", ["http_429", "http_500", "timeout", "token"])
async def test_sdk_delivery_failure_reaches_the_caller(monkeypatch, failure):
    def put(*args, **kwargs):
        if failure == "timeout":
            raise requests.ReadTimeout("card update timed out")
        response = requests.Response()
        response.status_code = 429 if failure == "http_429" else 500
        response._content = b"{}"
        response._content_consumed = True
        return response

    monkeypatch.setattr(requests, "put", put)
    client = SimpleNamespace(
        get_access_token=Mock(return_value=None if failure == "token" else "test-token")
    )
    emitter = StreamingResponseEmitter(
        client, SimpleNamespace(hosting_context=None), "card-1"
    )

    with pytest.raises((requests.RequestException, RuntimeError)):
        await emitter.emit_done(1, 2, {"value": "final"})
    assert not emitter._finished
    await emitter.close()


@pytest.mark.asyncio
async def test_sdk_updates_have_timeout_and_keep_full_final_payload(monkeypatch):
    calls = []

    def put(url, **kwargs):
        calls.append((url, kwargs))
        response = requests.Response()
        response.status_code = 200
        response._content = b"{}"
        response._content_consumed = True
        return response

    monkeypatch.setattr(requests, "put", put)
    emitter = StreamingResponseEmitter(
        SimpleNamespace(get_access_token=lambda: "test-token"),
        SimpleNamespace(hosting_context=None),
        "card-1",
    )
    await emitter.emit_done(1, 2, {"value": "final"})

    assert emitter._finished
    assert all(call[1].get("timeout") == (5, 10) for call in calls)
    stream = next(kwargs["json"] for url, kwargs in calls if url.endswith("/streaming"))
    assert stream["isFull"] is True
    assert stream["content"] == "final"
    final = calls[-1][1]["json"]["cardData"]["cardParamMap"]
    assert final["msgContent"] == "final"
    assert final["flowStatus"] == AICardStatus.FINISHED


@pytest.mark.asyncio
@pytest.mark.parametrize("is_json", [True, False])
async def test_api_error_logs_identifiers_without_response_content(
    config, httpx_mock, caplog, is_json
):
    adapter = TemplateChatCardAdapter(
        Mock(get_access_token=Mock(return_value="secret-token")),
        None,
        config,
        77,
    )
    if is_json:
        httpx_mock.add_response(
            status_code=403,
            json={
                "code": "Forbidden.Test",
                "requestid": "request-test",
                "message": "private-response-content",
                "accessToken": "secret-token",
            },
        )
    else:
        httpx_mock.add_response(status_code=403, text="private-response-content")

    with caplog.at_level("INFO"), pytest.raises(RuntimeError, match="HTTP 403"):
        await adapter._request("POST", "instances", {})

    assert "card_request_failed" in caplog.text
    assert '"status_code": 403' in caplog.text
    if is_json:
        assert "Forbidden.Test" in caplog.text
        assert "request-test" in caplog.text
    assert "private-response-content" not in caplog.text
    assert "secret-token" not in caplog.text


@pytest.mark.asyncio
async def test_delivery_logs_only_correlation_fields(
    config, binding, cache, httpx_mock, caplog
):
    client = SimpleNamespace(
        get_access_token=lambda: "secret-token",
        credential=SimpleNamespace(client_id="robot-a"),
    )
    adapter = TemplateChatCardAdapter(
        client, ChatbotMessage.from_dict(binding.incoming_data), config, 77
    )
    httpx_mock.add_response(json={"success": True})
    httpx_mock.add_response(
        json={
            "success": True,
            "result": [
                {
                    "carrierId": "carrier-test",
                    "spaceType": "IM_GROUP",
                    "spaceId": "group-a",
                    "success": True,
                    "token": "do-not-log",
                    "content": "private-content",
                }
            ],
        }
    )
    with caplog.at_level("INFO"):
        await adapter.start()
    assert "card_delivered" in caplog.text
    assert "carrier-test" in caplog.text and adapter.out_track_id in caplog.text
    assert "do-not-log" not in caplog.text
    assert "private-content" not in caplog.text
    assert "secret-token" not in caplog.text
