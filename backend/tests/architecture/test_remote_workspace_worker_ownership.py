# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Keep remote workspace and non-WebSocket cancellation out of Uvicorn."""

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


def test_remote_workspace_web_endpoints_are_transport_only() -> None:
    path = APP_ROOT / "api/endpoints/adapter/tasks.py"
    status_source = _function_source(path, "get_remote_workspace_status")
    tree_source = _function_source(path, "get_remote_workspace_tree")
    file_source = _function_source(path, "get_remote_workspace_file")
    execute_source = _function_source(path, "_execute_worker_operation")

    assert "_execute_worker_operation" in status_source
    assert "_execute_worker_operation" in tree_source
    assert "web_stream_worker_client.execute" in execute_source
    assert "web_stream_worker_client.open_raw_stream" in file_source
    assert "StreamingResponse" in file_source
    for source in (status_source, tree_source, file_source):
        for forbidden in (
            "remote_workspace_service",
            "httpx",
            "get_db",
            "Session",
            "response.content",
        ):
            assert forbidden not in source


def test_remote_file_upstream_is_incremental_and_hard_bounded() -> None:
    path = APP_ROOT / "services/remote_workspace_service.py"
    open_source = _function_source(path, "open_file_stream")
    chunk_source = _function_source(path, "chunks")
    source = path.read_text(encoding="utf-8")

    assert "httpx.AsyncClient" in open_source
    assert "stream=True" in open_source
    assert "content-length" in open_source
    assert "aiter_bytes" in chunk_source
    assert "REMOTE_WORKSPACE_FILE_MAX_BYTES" in chunk_source
    assert "response.content" not in open_source
    assert "response.content" not in chunk_source
    assert "def stream_file(" not in source
    assert "def _download_file(" not in source


def test_remote_file_ipc_has_metadata_backpressure_and_disconnect_cleanup() -> None:
    client_source = (APP_ROOT / "services/execution/web_stream_client.py").read_text(
        encoding="utf-8"
    )
    worker_source = (APP_ROOT / "stream_worker.py").read_text(encoding="utf-8")
    protocol_source = (
        APP_ROOT / "services/execution/web_stream_protocol.py"
    ).read_text(encoding="utf-8")

    for required in (
        "WEB_STREAM_FRAME_METADATA",
        "read_admitted_raw_frame",
        "_WebRawStreamBody",
        "await self._lease.release()",
        "WEB_STREAM_MAX_TOTAL_BYTES",
        "WEB_STREAM_MAX_DURATION_SECONDS",
    ):
        assert required in client_source or required in protocol_source
    assert "disconnect_task = asyncio.create_task(reader.read(1))" in worker_source
    assert "stream_task.cancel()" in worker_source
    assert "REMOTE_WORKSPACE_FILE_STREAM" in protocol_source


def test_non_websocket_cancel_crosses_worker_point_rpc() -> None:
    path = APP_ROOT / "services/execution/dispatcher.py"
    cancel_source = _function_source(path, "cancel")
    worker_source = _function_source(path, "cancel_worker_owned")

    assert "web_stream_worker_client.execute" in cancel_source
    assert "EXECUTION_CANCEL_EXECUTE" in cancel_source
    assert "self._cancel_http" not in cancel_source
    assert "self._cancel_sse" not in cancel_source
    assert "self._cancel_http" in worker_source
    assert "self._cancel_sse" in worker_source
