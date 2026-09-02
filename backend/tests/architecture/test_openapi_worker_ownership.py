# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Keep OpenAPI execution and stream projection out of Uvicorn."""

from __future__ import annotations

import ast
from pathlib import Path

APP_ROOT = Path(__file__).parents[2] / "app"


def _function_source(path: Path, name: str) -> str:
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    function = next(
        node
        for node in ast.walk(tree)
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
        and node.name == name
    )
    return ast.unparse(function)


def test_web_streaming_endpoint_is_transport_only_after_request_preparation() -> None:
    path = APP_ROOT / "api/endpoints/openapi_responses.py"
    source = _function_source(path, "_create_streaming_response_unified")

    assert "openapi_worker_client.stream" in source
    assert "StreamingResponse" in source
    for forbidden in (
        "execution_dispatcher",
        "SSEResultEmitter",
        "StreamingChunk",
        "streaming_service",
        "session_manager",
        "ExecutionEvent",
        "ResponsesAPIEventParser",
        "json.loads",
        "json.dumps",
    ):
        assert forbidden not in source


def test_web_nonstream_endpoint_never_dispatches_locally() -> None:
    path = APP_ROOT / "api/endpoints/openapi_responses.py"
    source = _function_source(path, "_create_non_streaming_response_unified")

    assert "openapi_worker_client.execute" in source
    assert "execution_dispatcher" not in source
    assert "SSEResultEmitter" not in source


def test_worker_client_offloads_request_projection() -> None:
    path = APP_ROOT / "services/openapi/worker_client.py"
    for method in ("stream", "execute"):
        source = _function_source(path, method)
        assert "run_payload_codec" in source
        assert ".to_dict()" not in source


def test_worker_owns_projection_cancellation_and_all_execution_modes() -> None:
    worker_source = (APP_ROOT / "services/openapi/worker_execution.py").read_text(
        encoding="utf-8"
    )
    for required in (
        "OpenAPIEventProjector",
        "StreamingChunk",
        "streaming_service.create_streaming_response",
        "self._session_manager.is_cancelled",
        "dispatch_worker_owned",
    ):
        assert required in worker_source

    dispatcher_path = APP_ROOT / "services/execution/dispatcher.py"
    dispatch_source = _function_source(dispatcher_path, "_dispatch_to_target")
    worker_entry = _function_source(dispatcher_path, "dispatch_worker_owned")
    assert "self._dispatch_polling" in dispatch_source
    assert "self._dispatch_inprocess" in dispatch_source
    assert "self._dispatch_to_target" in worker_entry
    assert "sse_upstream=True" in worker_entry
