"""Exercise actual SDK card transitions with mocked HTTP responses."""

from types import SimpleNamespace
from unittest.mock import Mock

import pytest
import requests
from dingtalk_stream.card_replier import AICardStatus

from app.services.channels.dingtalk.emitter import StreamingResponseEmitter


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
async def test_custom_answer_card_preserves_checked_delivery(monkeypatch):
    response = requests.Response()
    response.status_code = 500
    response._content = b"{}"
    response._content_consumed = True
    monkeypatch.setattr(requests, "put", lambda *args, **kwargs: response)
    client = SimpleNamespace(get_access_token=Mock(return_value="test-token"))
    emitter = StreamingResponseEmitter(
        client,
        SimpleNamespace(hosting_context=None),
        existing_card_instance_id="card-1",
        conversation_card_template_id="answer.schema",
        interaction_card_template_id="settings.schema",
        channel_id=77,
        user_id=9,
    )

    with pytest.raises(requests.HTTPError):
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
