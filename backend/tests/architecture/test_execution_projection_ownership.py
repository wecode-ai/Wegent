# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Keep execution projection side effects out of the sole Uvicorn worker."""

import ast
from pathlib import Path

APP_ROOT = Path(__file__).parents[2] / "app"


def test_web_point_event_handlers_are_transport_only() -> None:
    forbidden = {
        "StatusUpdatingEmitter",
        "WebSocketResultEmitter",
        "session_manager",
        "forward_event_to_channel_callbacks",
    }
    for relative_path in (
        "api/endpoints/internal/callback.py",
        "api/ws/device_namespace.py",
    ):
        source = (APP_ROOT / relative_path).read_text(encoding="utf-8")
        for symbol in forbidden:
            assert symbol not in source, f"{relative_path} owns {symbol}"


def test_dispatcher_has_no_local_projection_or_completion_fallback() -> None:
    source = (APP_ROOT / "services/execution/dispatcher.py").read_text(encoding="utf-8")
    for symbol in (
        "StatusUpdatingEmitter",
        "WebSocketResultEmitter",
        "_WebSSECompletionEmitter",
    ):
        assert symbol not in source
    assert "RemoteProjectionEmitter" in source


def test_local_task_channel_projection_uses_channel_worker_only() -> None:
    source = (APP_ROOT / "api/ws/local_task_responses.py").read_text(encoding="utf-8")
    for symbol in (
        "get_callback_registry",
        "forward_event_to_channel_callbacks",
        "runtime_local_task_callback_key",
    ):
        assert symbol not in source
    assert "channel_worker_client.runtime_local_event" in source


def test_device_execution_handlers_only_submit_worker_point_events() -> None:
    path = APP_ROOT / "api/ws/device_namespace.py"
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    device_namespace = next(
        node
        for node in tree.body
        if isinstance(node, ast.ClassDef) and node.name == "DeviceNamespace"
    )
    handlers = {
        node.name: ast.unparse(node)
        for node in device_namespace.body
        if isinstance(node, ast.AsyncFunctionDef)
        and node.name
        in {
            "_handle_responses_api_event",
            "on_runtime_event",
            "on_runtime_task_updated",
        }
    }
    assert set(handlers) == {
        "_handle_responses_api_event",
        "on_runtime_event",
        "on_runtime_task_updated",
    }
    forbidden = {
        "run_sync_in_executor",
        "get_sio",
        "im_notification_dispatcher",
        "LocalTaskResponsesHandler",
        "StatusUpdatingEmitter",
        "WebSocketResultEmitter",
        "_project_chat_runtime_event_sync",
        "_execution_runtime_event_sync",
        "_forward_runtime_event",
        "_notify_runtime_event",
    }
    for handler_name, source in handlers.items():
        for symbol in forbidden:
            assert symbol not in source, f"{handler_name} owns {symbol}"
        assert "stream_execution_client.dispatch_" in source


def test_callback_response_validation_is_codec_offloaded() -> None:
    path = APP_ROOT / "api/endpoints/internal/callback.py"
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    dispatch = next(
        node
        for node in ast.walk(tree)
        if isinstance(node, ast.AsyncFunctionDef)
        and node.name == "_dispatch_callback_body"
    )
    direct_validation = [
        node
        for node in ast.walk(dispatch)
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute)
        and node.func.attr == "model_validate"
    ]
    assert direct_validation == []
    assert "run_payload_codec" in ast.unparse(dispatch)
