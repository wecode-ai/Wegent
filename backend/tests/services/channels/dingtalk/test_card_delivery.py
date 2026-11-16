"""Exercise actual card transitions with mocked asynchronous HTTP responses."""

import json
from types import SimpleNamespace

import httpx
import pytest
from dingtalk_stream import ChatbotMessage
from dingtalk_stream.card_replier import AICardStatus

from app.services.channels.dingtalk.card_adapter import TemplateChatCardAdapter
from app.services.channels.dingtalk.card_quotes import quote_key
from app.services.channels.dingtalk.conversation import DingTalkConversationType
from app.services.channels.dingtalk.emitter import StreamingResponseEmitter
from tests.services.channels.dingtalk.test_chat_card import binding, cache, config


def cached_client(token="test-token"):
    return SimpleNamespace(
        _access_token={"accessToken": token, "expireTime": float("inf")},
        credential=SimpleNamespace(client_id="robot-a", client_secret="test-secret"),
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", ["http_429", "http_500", "timeout", "token"])
async def test_delivery_failure_reaches_the_caller(httpx_mock, failure):
    client = cached_client()
    if failure == "token":
        client._access_token = None
        httpx_mock.add_response(status_code=403, json={})
    elif failure == "timeout":
        httpx_mock.add_exception(httpx.ReadTimeout("timed out"), is_reusable=True)
    else:
        httpx_mock.add_response(
            status_code=429 if failure == "http_429" else 500,
            json={},
            is_reusable=True,
        )
    emitter = StreamingResponseEmitter(
        client, SimpleNamespace(hosting_context=None), "card-1"
    )
    try:
        with pytest.raises(RuntimeError):
            await emitter.emit_done(1, 2, {"value": "final"})
        assert not emitter._finished
    finally:
        await emitter.close()


@pytest.mark.asyncio
async def test_updates_have_timeout_and_keep_full_final_payload(httpx_mock):
    httpx_mock.add_response(json={}, is_reusable=True)
    emitter = StreamingResponseEmitter(
        cached_client(), SimpleNamespace(hosting_context=None), "card-1"
    )
    try:
        await emitter.emit_done(1, 2, {"value": "final"})
        assert emitter._finished
        calls = httpx_mock.get_requests()
        assert all(
            call.extensions["timeout"]
            == {
                "connect": 5,
                "read": 10,
                "write": 10,
                "pool": 10,
            }
            for call in calls
        )
        stream = next(
            json.loads(r.content) for r in calls if r.url.path.endswith("/streaming")
        )
        assert stream["isFull"] is True
        assert stream["content"] == "final"
        final = json.loads(calls[-1].content)["cardData"]["cardParamMap"]
        assert final["msgContent"] == "final"
        assert final["flowStatus"] == AICardStatus.FINISHED
    finally:
        await emitter.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("is_json", [True, False])
async def test_api_error_logs_identifiers_without_response_content(
    config, httpx_mock, caplog, is_json
):
    adapter = TemplateChatCardAdapter(
        cached_client("secret-token"),
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
    client = cached_client("secret-token")
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


@pytest.mark.asyncio
async def test_private_delivery_saves_quote_address(config, binding, cache, httpx_mock):
    private = binding.model_copy(
        update={
            "incoming_data": {
                **binding.incoming_data,
                "conversationId": "dm-a",
                "conversationType": DingTalkConversationType.PRIVATE,
            }
        }
    )
    adapter = TemplateChatCardAdapter(
        cached_client(),
        ChatbotMessage.from_dict(private.incoming_data),
        config,
        77,
    )
    httpx_mock.add_response(json={"success": True})
    httpx_mock.add_response(
        json={
            "success": True,
            "result": [
                {
                    "carrierId": "private-carrier",
                    "spaceType": "IM_ROBOT",
                    "spaceId": "staff-a",
                    "success": True,
                }
            ],
        }
    )

    await adapter.start()

    assert (
        await cache.get(quote_key(77, "dm-a", "private-carrier"))
        == adapter.out_track_id
    )


@pytest.mark.asyncio
async def test_group_delivery_rejects_foreign_space(config, binding, cache, httpx_mock):
    adapter = TemplateChatCardAdapter(
        cached_client(),
        ChatbotMessage.from_dict(binding.incoming_data),
        config,
        77,
    )
    httpx_mock.add_response(json={"success": True})
    httpx_mock.add_response(
        json={
            "success": True,
            "result": [
                {
                    "carrierId": "foreign-carrier",
                    "spaceType": "IM_GROUP",
                    "spaceId": "another-group",
                    "success": True,
                }
            ],
        }
    )

    await adapter.start()

    assert await cache.get(quote_key(77, "group-a", "foreign-carrier")) is None


@pytest.mark.asyncio
async def test_failed_quote_address_retries_without_redelivering(
    config, binding, cache, httpx_mock, monkeypatch
):
    """A failed address write keeps the card retryable and delivers it once."""
    adapter = TemplateChatCardAdapter(
        cached_client(),
        ChatbotMessage.from_dict(binding.incoming_data),
        config,
        77,
    )
    real_set = cache.set
    failures = [1]

    async def flaky_set(key, value, expire=None):
        if failures:
            failures.pop()
            return False
        return await real_set(key, value, expire)

    monkeypatch.setattr(cache, "set", flaky_set)
    httpx_mock.add_response(json={"success": True})
    httpx_mock.add_response(
        json={
            "success": True,
            "result": [
                {
                    "carrierId": "carrier-retry",
                    "spaceType": "IM_GROUP",
                    "spaceId": "group-a",
                    "success": True,
                }
            ],
        }
    )

    with pytest.raises(RuntimeError, match="quoted card address"):
        await adapter.start()
    assert adapter.card_instance_id is None
    assert await cache.get(quote_key(77, "group-a", "carrier-retry")) is None
    assert len(httpx_mock.get_requests()) == 2

    await adapter.start()

    assert adapter.card_instance_id == adapter.out_track_id
    assert len(httpx_mock.get_requests()) == 2
    assert (
        await cache.get(quote_key(77, "group-a", "carrier-retry"))
        == adapter.out_track_id
    )
