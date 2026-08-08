# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from types import SimpleNamespace

import pytest

from executor_manager.routers import routers


class _FakeAsyncClient:
    async def post(self, url, json):
        return SimpleNamespace(status_code=200, text="ok")


class _FakeClientContext:
    async def __aenter__(self):
        return _FakeAsyncClient()

    async def __aexit__(self, exc_type, exc, tb):
        return False


class _RecordingAsyncClient:
    def __init__(self, requests):
        self.requests = requests

    async def post(self, url, json):
        self.requests.append((url, json))
        return SimpleNamespace(status_code=200, text="ok")


class _RecordingClientContext:
    def __init__(self, requests):
        self.requests = requests

    async def __aenter__(self):
        return _RecordingAsyncClient(self.requests)

    async def __aexit__(self, exc_type, exc, tb):
        return False


class _FakeRecordingSpan:
    def is_recording(self):
        return True

    def set_attribute(self, key, value):
        pass


@pytest.mark.asyncio
async def test_callback_handler_logs_callback_summary_without_body(mocker):
    event_data = {
        "event_type": "response.output_text.delta",
        "task_id": 42,
        "subtask_id": 7,
        "validation_id": "validation-1",
        "delta": "hello",
    }
    http_request = SimpleNamespace(client=SimpleNamespace(host="127.0.0.1"))
    mocked_info = mocker.patch.object(routers.logger, "info")
    mocker.patch.object(
        routers, "traced_async_client", return_value=_FakeClientContext()
    )
    mocker.patch.object(routers, "set_task_context")

    await routers.callback_handler(event_data, http_request)

    assert any(
        "[Callback] Summary:" in call.args[0]
        and "event_type=response.output_text.delta" in call.args[0]
        and "task_id=42" in call.args[0]
        for call in mocked_info.call_args_list
    )
    assert all("hello" not in call.args[0] for call in mocked_info.call_args_list)


@pytest.mark.asyncio
async def test_callback_handler_updates_validation_without_local_registry(mocker):
    event_data = {
        "event_type": "response.completed",
        "task_id": 42,
        "subtask_id": 1,
        "validation_id": "validation-1",
        "data": {
            "response": {
                "output": [
                    {
                        "content": [
                            {
                                "type": "output_text",
                                "text": '{"valid": true, "checks": []}',
                            }
                        ]
                    }
                ]
            }
        },
    }
    http_request = SimpleNamespace(client=SimpleNamespace(host="127.0.0.1"))
    mocker.patch.object(
        routers, "traced_async_client", return_value=_FakeClientContext()
    )
    mocker.patch.object(routers, "set_task_context")
    update_status = mocker.patch.object(
        routers,
        "_update_validation_status_from_callback",
        new_callable=mocker.AsyncMock,
    )
    tracker = mocker.Mock()
    mocker.patch(
        "executor_manager.services.task_heartbeat_manager.get_running_task_tracker",
        return_value=tracker,
    )

    await routers.callback_handler(event_data, http_request)

    update_status.assert_awaited_once_with(
        "validation-1", "response.completed", event_data
    )
    tracker.remove_running_task.assert_called_once_with(42)


@pytest.mark.asyncio
async def test_validation_error_uses_executor_error_message(mocker):
    requests = []
    mocker.patch.object(
        routers,
        "traced_async_client",
        return_value=_RecordingClientContext(requests),
    )

    await routers._update_validation_status_from_callback(
        "validation-1",
        "error",
        {"data": {"type": "error", "message": "claude command not found"}},
    )

    assert len(requests) == 1
    url, payload = requests[0]
    assert url.endswith("/api/shells/validation-status/validation-1")
    assert payload["valid"] is False
    assert payload["errorMessage"] == "claude command not found"


@pytest.mark.asyncio
async def test_callback_route_skips_otel_body_capture(mocker):
    request = SimpleNamespace(
        url=SimpleNamespace(path=f"{routers.ROUTE_PREFIX}/callback"),
        headers={},
        method="POST",
        client=SimpleNamespace(host="127.0.0.1"),
        query_params="",
        state=SimpleNamespace(),
        body=mocker.AsyncMock(return_value=b'{"delta":"secret"}'),
    )
    response = SimpleNamespace(
        status_code=200,
        headers={},
    )
    call_next = mocker.AsyncMock(return_value=response)
    otel_config = SimpleNamespace(
        enabled=True,
        capture_request_body=True,
        capture_response_body=True,
        capture_response_headers=False,
    )

    mocker.patch.object(routers, "get_otel_config", return_value=otel_config)
    mocker.patch(
        "opentelemetry.trace.get_current_span", return_value=_FakeRecordingSpan()
    )
    log_body = mocker.patch.object(routers, "log_json_body")

    result = await routers.log_requests(request, call_next)

    assert result is response
    request.body.assert_not_awaited()
    log_body.assert_not_called()
