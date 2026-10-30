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
from app.api.endpoints import openapi_responses, wework_api
from app.models.api_key import APIKey
from app.schemas.runtime_work import RuntimeTranscriptResponse, RuntimeWorkListResponse
from app.services.device.runtime_route import RuntimeRouteError
from app.services.device.runtime_rpc_service import RuntimeRpcError
from app.services.wework_api import events, models, native, service
from app.services.wework_api.identity import ResponseIdentity, conversation_id

PREFIX = "/api/v1"


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
    app.include_router(wework_api.router, prefix="/api")
    app.include_router(openapi_responses.router, prefix=f"{PREFIX}/responses")
    # Exercise the retained Python reference after production cutover to Rust.
    app.add_api_route(
        f"{PREFIX}/responses", openapi_responses.create_response, methods=["POST"]
    )
    app.dependency_overrides[get_db] = lambda: test_db
    monkeypatch.setattr(openapi_responses.limiter, "enabled", False)
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
            turns=[],
            messages=messages[start:end],
            hasMoreBefore=start > 0,
            beforeCursor=str(start) if start else None,
        )

    async def rpc(*, user_id, device_id, method, payload):
        assert method == "runtime.tasks.get"
        try:
            await native.runtime_route_resolver.resolve(
                user_id=user_id, submitted_device_id=device_id
            )
        except RuntimeRouteError as exc:
            raise RuntimeRpcError(str(exc), code=exc.code) from exc
        task = harness.tasks.get(payload["taskId"])
        if user_id != test_user.id or device_id != "device-1" or task is None:
            return {
                "success": False,
                "code": "task_not_found",
                "error": "Task not found",
            }
        return {"success": True, "task": task}

    harness.create = AsyncMock(side_effect=create)
    monkeypatch.setattr(events, "subscribe", subscribe)
    monkeypatch.setattr(service.runtime, "create_runtime_task", harness.create)
    harness.send = AsyncMock(side_effect=send)
    harness.rpc = AsyncMock(side_effect=rpc)
    monkeypatch.setattr(service.runtime, "send_runtime_message", harness.send)
    monkeypatch.setattr(native.runtime_rpc_service, "call", harness.rpc)
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
            "execution": {"type": "wework", "device_id": "device-1"},
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


def test_conversation_paging_always_exposes_latest_turn(api):
    first = submit(api).json()
    finish(api, first["id"])
    second = submit(
        api, conversation=first["conversation"]["id"], execution=None
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


@pytest.mark.parametrize(
    "fields",
    [
        {"input": " "},
        {"tools": [{"type": "function"}]},
        {"input": [{"role": "assistant", "content": "fake history"}]},
        {"conversation": "conv_x", "previous_response_id": "resp_x"},
        {
            "execution": {
                "type": "wework",
            }
        },
    ],
)
def test_unsupported_or_invalid_input_fails_before_dispatch(api, fields):
    assert submit(api, **fields).status_code == 422
    api.create.assert_not_awaited()


def test_python_backend_only_registers_unmigrated_public_routes(test_app):
    paths = {route.path for route in test_app.routes if hasattr(route, "path")}
    assert f"{PREFIX}/responses" not in paths
    assert f"{PREFIX}/conversations" in paths
    assert "/v1/api/wework/responses" not in paths


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
        user_id=1,
        devices=[{"device_id": "target", "status": "online"}],
        pending_only=False,
    )


@pytest.mark.parametrize("execution", [{"type": "typo"}, "wework", ["wework"]])
def test_invalid_execution_does_not_fall_through_to_wegent(api, execution):
    result = submit(api, execution=execution)
    assert result.status_code == 422
    assert not api.calls


def test_legacy_requests_reach_existing_team_lookup(api, monkeypatch):
    lookup = AsyncMock()
    monkeypatch.setattr(service, "create_response", lookup)
    result = api.client.post(
        f"{PREFIX}/responses",
        json={
            "model": "default#missing-agent",
            "input": "hello",
            "tools": [{"type": "wegent_chat_bot"}],
            "stream": True,
        },
    )
    assert result.status_code == 404, result.text
    assert "Team" in result.json()["detail"]
    lookup.assert_not_awaited()


def test_missing_task_does_not_report_device_offline(api):
    result = submit(
        api, conversation=conversation_id("device-1", "missing"), execution=None
    )
    assert result.status_code == 404
    assert result.json()["detail"]["code"] == "task_not_found"
    api.send.assert_not_awaited()


def test_task_lookup_failure_is_not_hidden_as_missing_or_offline(api):
    api.rpc.side_effect = RuntimeRpcError("RPC timed out", code="runtime_rpc_timeout")
    result = submit(
        api, conversation=conversation_id("device-1", "existing"), execution=None
    )
    assert result.status_code == 502
    assert result.json()["detail"]["code"] == "runtime_rpc_timeout"
    api.send.assert_not_awaited()


@pytest.mark.parametrize(
    "result",
    [
        {"success": False, "code": "unsupported_method", "error": "Unsupported RPC"},
        {"success": True, "task": {}},
        {
            "success": True,
            "task": {
                "taskId": "different-task",
                "workspacePath": "/project",
                "title": "Wrong task",
                "runtime": "codex",
            },
        },
    ],
)
def test_task_lookup_rejects_invalid_result_without_listing_fallback(
    api, monkeypatch, result
):
    api.rpc.side_effect = None
    api.rpc.return_value = result
    listing = AsyncMock(side_effect=AssertionError("Must not fall back to listing"))
    monkeypatch.setattr(native.runtime, "list_runtime_work", listing)

    response = submit(
        api, conversation=conversation_id("device-1", "existing"), execution=None
    )

    assert response.status_code == 502
    listing.assert_not_awaited()
    api.send.assert_not_awaited()


def test_conversation_listing_includes_project_tasks(api, monkeypatch):
    work = RuntimeWorkListResponse(
        totalTasks=1,
        projects=[
            {
                "project": {"key": "project-1", "name": "Project"},
                "deviceWorkspaces": [
                    {
                        "deviceId": "device-1",
                        "deviceName": "Device",
                        "deviceStatus": "online",
                        "workspacePath": "/project",
                        "mapped": True,
                        "available": True,
                        "tasks": [
                            {
                                "taskId": "project-task",
                                "workspacePath": "/project",
                                "title": "Project task",
                                "runtime": "codex",
                            }
                        ],
                    }
                ],
            }
        ],
    )
    monkeypatch.setattr(
        native.runtime, "list_runtime_work", AsyncMock(return_value=work)
    )

    response = api.client.get(f"{PREFIX}/conversations")

    assert response.status_code == 200
    assert [item["id"] for item in response.json()["data"]] == [
        conversation_id("device-1", "project-task")
    ]


@pytest.mark.parametrize("response_id", ["123", "resp_123", "resp_invalid"])
@pytest.mark.parametrize(
    "stream, background", [(False, False), (True, False), (False, True)]
)
def test_legacy_continuation_never_enters_wework(
    api, monkeypatch, response_id, stream, background
):
    create = AsyncMock()
    monkeypatch.setattr(service, "create_response", create)
    result = api.client.post(
        f"{PREFIX}/responses",
        json={
            "model": "default#missing-agent",
            "input": "continue",
            "previous_response_id": response_id,
            "stream": stream,
            "background": background,
        },
    )
    assert result.status_code in {400, 404}
    create.assert_not_awaited()
    api.rpc.assert_not_awaited()


@pytest.mark.parametrize(
    "options",
    [
        {"tools": [{"type": "wegent_chat_bot"}]},
        {"attachment_ids": [1]},
        {"wegent_options": {"include_task_context": True}},
        {"wework_options": {"device_id": "device-1"}},
    ],
)
def test_wework_rejects_unsupported_or_removed_extensions(api, options):
    assert submit(api, **options).status_code == 422
    assert not api.calls


def test_sdk_extra_body_uses_unified_endpoint(api):
    import httpx
    from openai import OpenAI

    def dispatch(request):
        result = api.client.request(
            request.method,
            request.url.path,
            headers=dict(request.headers),
            content=request.content,
        )
        return httpx.Response(
            result.status_code, headers=result.headers, content=result.content
        )

    token = api.client.headers["Authorization"].split(" ", 1)[1]
    with OpenAI(
        base_url=f"http://testserver{PREFIX}",
        api_key=token,
        http_client=httpx.Client(transport=httpx.MockTransport(dispatch)),
    ) as client:
        result = client.responses.create(
            model="model-1",
            input="hello",
            background=True,
            extra_body={"execution": {"type": "wework", "device_id": "device-1"}},
        )
    assert result.status == "queued"
    assert ResponseIdentity.parse(result.id).device_id == "device-1"


def test_unified_openapi_has_one_responses_route(api):
    routes = [
        route
        for route in api.client.app.routes
        if getattr(route, "path", "") == f"{PREFIX}/responses"
    ]
    assert len(routes) == 1
    schema = api.client.app.openapi()
    body = schema["paths"][f"{PREFIX}/responses"]["post"]["requestBody"]["content"][
        "application/json"
    ]["schema"]
    assert {item["$ref"].split("/")[-1] for item in body["oneOf"]} == {
        "WeworkResponseCreate",
        "ResponseCreateInput",
    }


@pytest.mark.parametrize("path", ["models", "conversations"])
def test_discovery_rejects_unimplemented_execution_types(api, path):
    assert api.client.get(f"{PREFIX}/{path}?execution=wegent").status_code == 422
