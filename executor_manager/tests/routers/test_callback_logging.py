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
