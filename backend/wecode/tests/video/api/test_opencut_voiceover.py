# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from copy import deepcopy
from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from wecode.video.api import opencut_voiceover as module
from wecode.video.api.opencut_urls import create_opencut_urls
from wecode.video.api.router import router


@pytest.fixture
def token() -> str:
    return create_opencut_urls(
        callback_base="https://callback.test",
        session_id="147_2",
        artifact_id="timeline-1",
        uid="owner",
        user_id=2,
    )["token"]


@pytest.fixture
def client(monkeypatch):
    upstream = AsyncMock(return_value={"task_id": "voice-1"})
    monkeypatch.setattr(module, "_request_aigc_json", upstream)
    app = FastAPI()
    app.include_router(router, prefix="/api/aigc-video")
    return TestClient(app), upstream


def body() -> dict:
    return {
        "updateScriptPayload": {
            "session_id": "147_2",
            "task_id": "timeline-1",
            "group_scripts": [{"group_id": "group_0001", "raw_text": "New script"}],
        },
        "generateVoiceoverPayload": {
            "session_id": "147_2",
            "task_id": "voice-1",
            "group_id": "group_0001",
            "target_duration_ms": 5592,
            "is_keep_audio": False,
        },
    }


PATH = "/api/aigc-video/material-video/opencut/voiceover/147_2"


def test_post_uses_signed_identity_without_login_and_preserves_order(client, token):
    http, upstream = client
    upstream.side_effect = [{"updated_count": 1}, {"task_id": "voice-1"}]
    payload = body()
    snapshot = deepcopy(payload)
    response = http.post(PATH, params={"token": token}, json=payload)
    assert response.status_code == 200
    assert response.json() == {
        "script": {"updated_count": 1},
        "voiceover": {"task_id": "voice-1"},
    }
    calls = upstream.await_args_list
    assert [call.kwargs["path"] for call in calls] == [
        "v2/material-video/update-script",
        "v2/material-video/generate-voiceover",
    ]
    assert all(call.kwargs["uid"] == "owner" for call in calls)
    assert calls[0].kwargs["payload"] == payload["updateScriptPayload"]
    assert calls[1].kwargs["payload"] == payload["generateVoiceoverPayload"]
    assert payload == snapshot


@pytest.mark.parametrize("method", ["get", "post"])
@pytest.mark.parametrize("foreign_session", [False, True])
def test_invalid_or_wrong_session_signature_never_calls_aigc(
    client, token, method, foreign_session
):
    http, upstream = client
    path = PATH.replace("147_2", "148_1") if foreign_session else PATH
    params = {"token": token if foreign_session else "invalid", "task_id": "voice-1"}
    response = (
        http.get(path, params=params)
        if method == "get"
        else http.post(path, params=params, json=body())
    )
    assert response.status_code == 401
    upstream.assert_not_awaited()


@pytest.mark.parametrize("key", ["updateScriptPayload", "generateVoiceoverPayload"])
@pytest.mark.parametrize(
    "invalid",
    [None, {}, {"task_id": "x", "session_id": "other"}, {"session_id": "147_2"}],
)
def test_validates_both_payloads_before_any_write(client, token, key, invalid):
    http, upstream = client
    payload = body()
    payload[key] = invalid
    response = http.post(PATH, params={"token": token}, json=payload)
    assert response.status_code == 400
    upstream.assert_not_awaited()


def test_missing_payload_sessions_are_bound_to_signed_route(client, token):
    http, upstream = client
    payload = body()
    for value in payload.values():
        value.pop("session_id")
    assert http.post(PATH, params={"token": token}, json=payload).status_code == 200
    assert all(
        call.kwargs["payload"]["session_id"] == "147_2"
        for call in upstream.await_args_list
    )


def test_script_failure_does_not_generate_voiceover(client, token):
    http, upstream = client
    upstream.side_effect = HTTPException(status_code=503, detail="script unavailable")
    response = http.post(PATH, params={"token": token}, json=body())
    assert response.status_code == 503
    assert upstream.await_count == 1


def test_generation_failure_is_returned_without_retry(client, token):
    http, upstream = client
    upstream.side_effect = [
        {"updated_count": 1},
        HTTPException(status_code=502, detail="generation unavailable"),
    ]
    response = http.post(PATH, params={"token": token}, json=body())
    assert response.status_code == 502
    assert upstream.await_count == 2


@pytest.mark.parametrize("group_id", [None, "group_0001"])
def test_poll_forwards_scope_and_filters_group(client, token, group_id):
    http, upstream = client
    records = [
        {"group_id": "group_0001", "url": "https://cdn.test/a.wav"},
        {"group_id": "other", "url": "https://cdn.test/b.wav"},
    ]
    upstream.return_value = {"voiceovers": records, "total": 2, "status": "completed"}
    params = {"token": token, "task_id": "voice-1"}
    if group_id:
        params["group_id"] = group_id
    response = http.get(PATH, params=params)
    assert response.status_code == 200
    assert response.json()["voiceovers"] == (records[:1] if group_id else records)
    assert response.json()["total"] == (1 if group_id else 2)
    assert upstream.await_args.kwargs == {
        "method": "GET",
        "path": "v2/material-video/generate-voiceover/147_2",
        "uid": "owner",
        "params": {key: value for key, value in params.items() if key != "token"},
    }


def test_poll_failure_is_not_reported_as_success(client, token):
    http, upstream = client
    upstream.side_effect = HTTPException(status_code=502, detail="poll unavailable")
    assert (
        http.get(PATH, params={"token": token, "task_id": "voice-1"}).status_code == 502
    )


def test_generic_proxy_still_requires_login(client):
    http, upstream = client
    assert (
        http.post(
            "/api/aigc-video/v2/material-video/generate-voiceover", json=body()
        ).status_code
        == 401
    )
    upstream.assert_not_awaited()
