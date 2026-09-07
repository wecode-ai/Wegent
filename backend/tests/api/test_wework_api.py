# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Public HTTP contract: real API key auth, mocked external native Runtime."""

import hashlib
import json
from collections import deque
from datetime import datetime, timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from app.api.dependencies import get_db
from app.api.endpoints import wework_api
from app.models.api_key import APIKey
from app.schemas.runtime_work import RuntimeTranscriptResponse, RuntimeWorkListResponse
from app.services.wework_api import events, models, native, service
from app.services.wework_api.identity import ResponseIdentity, conversation_id

PREFIX = "/v1/api/wework"


class FakeSubscription:
    def __init__(self):
        self.queue = deque()
        self.closed = False

    async def receive(self):
        assert self.queue, "Test Runtime did not emit the required terminal event"
        return self.queue.popleft()

    async def close(self):
        self.closed = True


@pytest.fixture
def api(test_db, test_user, monkeypatch):
    token = "wg-wework-api-test-key"
    key = APIKey(
        user_id=test_user.id,
        name="wework-test",
        key_hash=hashlib.sha256(token.encode()).hexdigest(),
        key_prefix="wg-test",
        key_type="personal",
        is_active=True,
        expires_at=datetime.utcnow() + timedelta(days=1),
    )
    test_db.add(key)
    test_db.commit()
    app = FastAPI()
    app.include_router(wework_api.router)
    app.dependency_overrides[get_db] = lambda: test_db
    monkeypatch.setattr(wework_api.limiter, "enabled", False)
    monkeypatch.setattr(
        models,
        "catalog",
        lambda *_: [
            {
                "name": "model-1",
                "type": "public",
                "namespace": "default",
                "resourceUserId": 0,
                "config": {"api_key": "must-never-be-exposed"},
            },
        ],
    )
    harness = SimpleNamespace(
        db=test_db,
        user=test_user,
        key=key,
        tasks={},
        messages={},
        subscriptions=[],
        calls=[],
    )

    def append_user(task_id, client_id, text):
        harness.messages[task_id].append(
            {
                "id": f"native-{client_id}",
                "clientUserMessageId": client_id,
                "role": "user",
                "content": text,
                "createdAt": "2026-09-07T01:00:00Z",
            }
        )

    async def subscribe(*_):
        subscription = FakeSubscription()
        harness.subscriptions.append(subscription)
        harness.calls.append("subscribe")
        return subscription

    async def create(*, db, user_id, request):
        harness.calls.append("create")
        assert user_id == test_user.id
        harness.tasks[request.local_task_id] = {
            "taskId": request.local_task_id,
            "workspacePath": "/chats/test",
            "title": request.title or "Test",
            "runtime": "codex",
            "workspaceKind": "chat",
            "running": False,
            "status": "pending",
            "modelSelection": {"modelName": request.model_id},
        }
        harness.messages[request.local_task_id] = []
        append_user(
            request.local_task_id, request.client_user_message_id, request.message
        )
        return SimpleNamespace(
            accepted=True,
            local_task_id=request.local_task_id,
            device_id=request.device_id,
        )

    async def send(*, db, user_id, request):
        append_user(
            request.address.local_task_id,
            request.client_user_message_id,
            request.message,
        )
        harness.tasks[request.address.local_task_id]["status"] = "pending"
        return SimpleNamespace(accepted=True)

    async def work(*, db, user_id, device_id=None):
        tasks = list(harness.tasks.values()) if user_id == test_user.id else []
        return RuntimeWorkListResponse(
            chats=[
                {
                    "deviceId": "device-1",
                    "deviceName": "Device",
                    "deviceStatus": "online",
                    "workspacePath": "/chats/test",
                    "workspaceKind": "chat",
                    "mapped": True,
                    "available": True,
                    "tasks": tasks,
                }
            ],
            totalTasks=len(tasks),
        )

    async def transcript(*, db, user_id, address):
        messages = harness.messages[address.local_task_id]
        end = int(address.before_cursor) if address.before_cursor else len(messages)
        start = max(0, end - (address.limit or 200))
        return RuntimeTranscriptResponse(
            taskId=address.local_task_id,
            workspacePath="/chats/test",
            runtime="codex",
            messages=messages[start:end],
            hasMoreBefore=start > 0,
            beforeCursor=str(start) if start else None,
        )

    harness.create = AsyncMock(side_effect=create)
    monkeypatch.setattr(events, "subscribe", subscribe)
    monkeypatch.setattr(service.runtime, "create_runtime_task", harness.create)
    monkeypatch.setattr(
        service.runtime, "send_runtime_message", AsyncMock(side_effect=send)
    )
    monkeypatch.setattr(service.runtime, "list_runtime_work", work)
    monkeypatch.setattr(service.runtime, "get_runtime_transcript", transcript)
    monkeypatch.setattr(
        service.runtime,
        "cancel_runtime_task",
        AsyncMock(return_value=SimpleNamespace(accepted=True)),
    )
    harness.client = TestClient(app)
    monkeypatch.setattr(native.runtime_route_resolver, "resolve", AsyncMock())
    harness.client.headers["Authorization"] = f"Bearer {token}"
    return harness


def submit(api, **options):
    return api.client.post(
        f"{PREFIX}/responses",
        json={
            "model": "model-1",
            "input": "hello",
            "background": True,
            "wework_options": {"device_id": "device-1"},
            **options,
        },
    )


def finish(api, identifier, text="done", status="completed"):
    identity = ResponseIdentity.parse(identifier)
    api.messages[identity.task_id].append(
        {
            "id": "assistant-1",
            "role": "assistant",
            "subtaskId": 101,
            "content": text,
            "status": status,
        }
    )
    api.tasks[identity.task_id].update(status=status, running=status == "streaming")


def event(identity, name, data, **payload):
    return {
        "event": name,
        "payload": {
            "taskId": identity.task_id,
            "subtaskId": 101,
            "clientUserMessageId": identity.message_id,
            "data": data,
            **payload,
        },
    }


def parse_sse(text):
    return [
        json.loads(line[6:]) for line in text.splitlines() if line.startswith("data: ")
    ]


def test_background_submission_only_uses_runtime_and_returns_native_handle(api):
    result = submit(api)
    assert result.status_code == 200, result.text
    body = result.json()
    identity = ResponseIdentity.parse(body["id"])
    assert body["status"] == "queued"
    request = api.create.await_args.kwargs["request"]
    assert request.standalone_chat_workspace is True
    assert request.client_user_message_id == identity.message_id
    assert api.subscriptions == []
    assert (
        api.client.get(f"{PREFIX}/responses/{identity.id}").json()["status"] == "queued"
    )
    assert "must-never" not in api.client.get(f"{PREFIX}/models").text


@pytest.mark.parametrize("endpoint", ["models", "devices"])
@pytest.mark.parametrize("header", [None, "Bearer bogus", "Bearer eyJ.jwt.token"])
def test_rejects_missing_invalid_or_jwt_auth(api, header, endpoint):
    api.client.headers.pop("Authorization")
    assert (
        api.client.get(
            f"{PREFIX}/{endpoint}", headers={"Authorization": header} if header else {}
        ).status_code
        == 401
    )


@pytest.mark.parametrize("endpoint", ["models", "devices"])
@pytest.mark.parametrize("change", ["expired", "revoked", "service", "inactive_user"])
def test_rejects_unusable_personal_keys(api, change, endpoint):
    if change == "expired":
        api.key.expires_at = datetime.utcnow() - timedelta(seconds=1)
    elif change == "revoked":
        api.key.is_active = False
    elif change == "service":
        api.key.key_type = "service"
    else:
        api.user.is_active = False
    api.db.commit()
    assert api.client.get(f"{PREFIX}/{endpoint}").status_code == 401


def test_query_is_turn_scoped_and_old_response_cannot_cancel_new_turn(api):
    first = submit(api).json()
    finish(api, first["id"], "first reply")
    second = submit(api, previous_response_id=first["id"], wework_options={}).json()
    assert first["id"] != second["id"]
    assert first["conversation"] == second["conversation"]
    old = api.client.get(f"{PREFIX}/responses/{first['id']}").json()
    assert old["is_latest"] is False
    assert old["output"][0]["content"][0]["text"] == "first reply"
    api.client.post(f"{PREFIX}/responses/{first['id']}/cancel")
    service.runtime.cancel_runtime_task.assert_not_awaited()
    assert (
        submit(api, previous_response_id=first["id"], wework_options={}).status_code
        == 409
    )


def test_unowned_device_handle_does_not_authorize_rpc(api):
    first = submit(api).json()
    identity = ResponseIdentity.parse(first["id"])
    foreign = ResponseIdentity("other-device", identity.task_id, identity.message_id)
    assert api.client.get(f"{PREFIX}/responses/{foreign.id}").status_code == 404
    assert api.client.post(f"{PREFIX}/responses/{foreign.id}/cancel").status_code == 404
    service.runtime.cancel_runtime_task.assert_not_awaited()


@pytest.mark.parametrize("turn_id", [101, "01a07b7f-715c-7023-a043-fe6067a7b5ed"])
def test_existing_pc_conversation_exposes_response_without_registration(api, turn_id):
    first = submit(api).json()
    identity = ResponseIdentity.parse(first["id"])
    api.messages[identity.task_id][0]["clientUserMessageId"] = "pc-message-1"
    finish(api, first["id"], "PC is working", "streaming")
    for message in api.messages[identity.task_id]:
        message["subtaskId"] = turn_id
    detail = api.client.get(f"{PREFIX}/conversations/{identity.conversation_id}").json()
    latest = detail["latest_response"]
    assert ResponseIdentity.parse(latest["id"]).message_id == "pc-message-1"
    assert latest["status"] == "in_progress"
    assert "_address" not in detail
    assert api.client.get(f"{PREFIX}/responses/{latest['id']}").json() == latest
    cancelled = api.client.post(f"{PREFIX}/responses/{latest['id']}/cancel").json()
    assert cancelled["cancellation_requested"] is True
    assert cancelled["status"] == "in_progress"
    assert service.runtime.cancel_runtime_task.await_args.kwargs[
        "runtime_turn_id"
    ] == str(turn_id)


def test_conversation_paging_always_exposes_latest_turn(api):
    first = submit(api).json()
    finish(api, first["id"])
    second = submit(
        api, conversation=first["conversation"]["id"], wework_options={}
    ).json()
    detail = api.client.get(
        f"{PREFIX}/conversations/{first['conversation']['id']}?limit=1&before=2"
    ).json()
    assert detail["latest_response"]["id"] == second["id"]
    assert detail["has_more"] is True


@pytest.mark.parametrize("mode", ["stream", "blocking"])
def test_subscribe_before_dispatch_preserves_fast_output_and_cleans_up(api, mode):
    create = api.create.side_effect

    async def complete(**kwargs):
        ack = await create(**kwargs)
        request = kwargs["request"]
        identity = ResponseIdentity(
            request.device_id, request.local_task_id, request.client_user_message_id
        )
        api.subscriptions[-1].queue.extend(
            [
                event(identity, "response.created", {}),
                event(identity, "response.output_text.delta", {"delta": "fast"}),
                event(identity, "response.completed", {"value": "fast result"}),
            ]
        )
        return ack

    api.create.side_effect = complete
    result = submit(api, stream=mode == "stream", background=False)
    assert result.status_code == 200, result.text
    assert api.calls == ["subscribe", "create"]
    if mode == "stream":
        output = parse_sse(result.text)
        assert output[0]["type"] == "response.created"
        assert [item["sequence_number"] for item in output] == list(range(len(output)))
        final = output[-1]["response"]
    else:
        final = result.json()
    assert final["status"] == "completed"
    assert final["output"][0]["content"][0]["text"] == "fast result"
    assert api.subscriptions[-1].closed


def test_runtime_rejection_closes_subscription_without_storing_response(api):
    api.create.side_effect = HTTPException(502, "Device disconnected")
    result = submit(api, stream=True)
    assert result.status_code == 502
    assert "response_id" in result.json()["detail"]
    assert api.subscriptions[-1].closed


def test_completed_response_streams_native_snapshot_without_live_events(api):
    first = submit(api).json()
    finish(api, first["id"])
    result = api.client.get(f"{PREFIX}/responses/{first['id']}?stream=true")
    assert parse_sse(result.text)[-1]["response"]["status"] == "completed"
    assert api.subscriptions[-1].closed
    assert (
        api.client.get(
            f"{PREFIX}/responses/{first['id']}?stream=true&starting_after=1"
        ).status_code
        == 400
    )


@pytest.mark.parametrize(
    "fields",
    [
        {"input": " "},
        {"tools": [{"type": "function"}]},
        {"input": [{"role": "assistant", "content": "fake history"}]},
        {"conversation": "conv_x", "previous_response_id": "resp_x"},
        {"wework_options": {}},
    ],
)
def test_unsupported_or_invalid_input_fails_before_dispatch(api, fields):
    assert submit(api, **fields).status_code == 422
    api.create.assert_not_awaited()


def test_malformed_resource_ids_fail_before_runtime_access(api):
    assert api.client.get(f"{PREFIX}/responses/resp_bad").status_code == 400
    assert api.client.get(f"{PREFIX}/conversations/conv_bad").status_code == 400


def test_actual_backend_registers_exact_public_prefix(test_app):
    paths = {route.path for route in test_app.routes if hasattr(route, "path")}
    assert f"{PREFIX}/responses" in paths
    assert f"{PREFIX}/conversations" in paths
    assert "/api/v1/api/wework/responses" not in paths


def test_live_reattachment_filters_other_turns_and_returns_complete_result(
    api, monkeypatch
):
    first = submit(api).json()
    identity = ResponseIdentity.parse(first["id"])
    finish(api, first["id"], "already generated", "streaming")
    original = events.subscribe

    async def subscribe(*args):
        subscription = await original(*args)
        subscription.queue.extend(
            [
                event(
                    identity,
                    "response.completed",
                    {"value": "wrong"},
                    clientUserMessageId="foreign-turn",
                ),
                event(identity, "response.output_text.delta", {"delta": "new text"}),
                event(
                    identity,
                    "response.completed",
                    {"value": "already generated new text"},
                ),
            ]
        )
        return subscription

    monkeypatch.setattr(events, "subscribe", subscribe)
    response = api.client.get(f"{PREFIX}/responses/{first['id']}?stream=true")
    output = parse_sse(response.text)
    assert output[0]["response"]["output"] == []
    assert "wrong" not in response.text
    assert (
        output[-1]["response"]["output"][0]["content"][0]["text"]
        == "already generated new text"
    )
    assert api.subscriptions[-1].closed


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "stream_factory", [service.response_events, service.stream_response]
)
async def test_disconnecting_sse_closes_subscription_without_cancelling_runtime(
    stream_factory,
):
    subscription = FakeSubscription()
    identity = ResponseIdentity("device", "task", "message")
    live = service.LiveResponse(
        1, identity, {"id": identity.id, "status": "queued", "output": []}, subscription
    )
    stream = stream_factory(live)
    await anext(stream)
    await stream.aclose()
    assert subscription.closed


def test_response_lookup_walks_runtime_pages(api):
    first = submit(api).json()
    finish(api, first["id"], "old answer")
    identity = ResponseIdentity.parse(first["id"])
    api.messages[identity.task_id].extend(
        {"id": f"later-{index}", "role": "user", "content": "later"}
        for index in range(205)
    )
    response = api.client.get(f"{PREFIX}/responses/{first['id']}")
    assert response.status_code == 200
    assert response.json()["output"][0]["content"][0]["text"] == "old answer"
    assert response.json()["is_latest"] is False


def test_cancelled_before_first_output_is_not_reported_as_queued(api):
    response = submit(api).json()
    identity = ResponseIdentity.parse(response["id"])
    api.tasks[identity.task_id]["status"] = "cancelled"
    snapshot = api.client.get(f"{PREFIX}/responses/{identity.id}").json()
    assert snapshot["status"] == "cancelled"
    assert snapshot["output"] == []


@pytest.mark.parametrize("statuses", [[], ["online", "offline", "busy"]])
def test_devices_are_user_scoped_and_expose_only_public_fields(
    api, monkeypatch, statuses
):
    devices = [
        {
            "device_id": f"device-{index}",
            "name": f"Machine {index}",
            "status": status,
            "is_default": index == 0,
            "client_ip": "private-address",
            "internal_metadata": "private",
        }
        for index, status in enumerate(statuses)
    ]
    listing = AsyncMock(return_value=devices)
    monkeypatch.setattr(wework_api.device_service, "get_all_devices", listing)

    result = api.client.get(f"{PREFIX}/devices")

    assert result.status_code == 200
    listing.assert_awaited_once_with(api.db, api.user.id)
    assert result.json() == {
        "object": "list",
        "data": [
            {
                "device_id": device["device_id"],
                "name": device["name"],
                "status": device["status"],
                "is_default": device["is_default"],
                "device_type": "local",
            }
            for device in devices
        ],
    }


@pytest.mark.parametrize("operation", ["response", "conversation", "cancel", "create"])
@pytest.mark.parametrize(
    "code, status", [("device_offline", 503), ("device_not_found", 404)]
)
def test_unavailable_device_fails_before_listing_or_dispatch(
    api, monkeypatch, operation, code, status
):
    from app.services.device.runtime_route import RuntimeRouteError

    identity = ResponseIdentity("device-1", "task-1", "message-1")
    resolver = AsyncMock(side_effect=RuntimeRouteError(code, "Device unavailable"))
    monkeypatch.setattr(native.runtime_route_resolver, "resolve", resolver)
    listing = AsyncMock()
    monkeypatch.setattr(native.runtime, "list_runtime_work", listing)
    if operation == "create":
        result = submit(api)
    elif operation == "cancel":
        result = api.client.post(f"{PREFIX}/responses/{identity.id}/cancel")
    else:
        path = (
            f"responses/{identity.id}"
            if operation == "response"
            else f"conversations/{identity.conversation_id}"
        )
        result = api.client.get(f"{PREFIX}/{path}")
    assert result.status_code == status
    assert result.json()["detail"]["code"] == code
    listing.assert_not_awaited()
    assert "create" not in api.calls
    resolver.assert_awaited_once_with(
        user_id=api.user.id, submitted_device_id="device-1"
    )


async def test_runtime_work_filters_devices_before_rpc(monkeypatch):
    listing = AsyncMock(return_value={})
    monkeypatch.setattr(
        native.runtime.device_service,
        "get_all_devices",
        AsyncMock(
            return_value=[
                {"device_id": "target", "status": "online"},
                {"device_id": "unrelated", "status": "online"},
            ]
        ),
    )
    monkeypatch.setattr(native.runtime, "_list_online_runtime_workspaces", listing)
    await native.runtime.list_runtime_work(db=None, user_id=1, device_id="target")
    listing.assert_awaited_once_with(
        user_id=1, devices=[{"device_id": "target", "status": "online"}]
    )
