# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from contextlib import asynccontextmanager
from types import SimpleNamespace
from unittest.mock import patch

import httpx
import pytest
from pytest_mock import MockerFixture

with patch(
    "executor_manager.executors.docker.executor.DockerExecutor._check_docker_availability"
):
    from executor_manager.routers import routers


class _FakeStreamResponse:
    def __init__(self, status_code=200, headers=None, chunks=None):
        self.status_code = status_code
        self.headers = headers or {}
        self._chunks = chunks if chunks is not None else [b""]
        self.consumed_chunks = 0

    async def aiter_bytes(self):
        for chunk in self._chunks:
            if isinstance(chunk, BaseException):
                raise chunk
            self.consumed_chunks += 1
            yield chunk

    @property
    def is_success(self):
        return 200 <= self.status_code < 300


def _mock_stream_client(mocker, response=None, exc=None):
    recorded = {}

    @asynccontextmanager
    async def fake_stream(method, url, params=None):
        recorded["method"] = method
        recorded["url"] = url
        recorded["params"] = params
        if exc is not None:
            raise exc
        yield response

    client = mocker.MagicMock()
    client.__aenter__ = mocker.AsyncMock(return_value=client)
    client.__aexit__ = mocker.AsyncMock(return_value=None)
    client.stream = fake_stream
    mocker.patch.object(routers.httpx, "AsyncClient", return_value=client)
    return recorded


@pytest.mark.asyncio
@pytest.mark.parametrize("file_chunks", [[b"# Report\n", b"body\n"], [b""]])
async def test_workspace_artifact_declare_and_download_forward_params(
    mocker: MockerFixture, file_chunks: list[bytes]
) -> None:
    sandbox_manager = mocker.MagicMock()
    sandbox_manager.get_sandbox = mocker.AsyncMock(return_value=None)
    mocker.patch(
        "executor_manager.services.sandbox.get_sandbox_manager",
        return_value=sandbox_manager,
    )
    mock_executor = mocker.MagicMock()
    mock_executor.get_container_address.return_value = {
        "status": "success",
        "base_url": "http://host.docker.internal:10022/",
    }
    mocker.patch.object(
        routers.ExecutorDispatcher, "get_executor", return_value=mock_executor
    )

    recorded = _mock_stream_client(
        mocker,
        response=_FakeStreamResponse(
            status_code=200,
            headers={"content-type": "application/json"},
            chunks=[b'{"workspace_root":"/workspace/42"}'],
        ),
    )
    http_request = SimpleNamespace(client=SimpleNamespace(host="127.0.0.1"))
    resp = await routers.get_executor_workspace_artifact(
        task_id=42,
        executor_name="executor-original",
        binding_id="b" * 64,
        subtask_id="7",
        executor_namespace="wegent-pod",
        http_request=http_request,
    )
    assert resp.status_code == 200
    assert resp.body == b'{"workspace_root":"/workspace/42"}'
    assert resp.media_type == "application/json"
    assert recorded["url"] == "http://host.docker.internal:10022/filesystem/artifact"
    assert recorded["params"] == {
        "binding_id": "b" * 64,
        "task_id": "42",
        "subtask_id": "7",
    }

    recorded_file = _mock_stream_client(
        mocker,
        response=_FakeStreamResponse(
            status_code=200,
            headers={"content-type": "text/markdown"},
            chunks=file_chunks,
        ),
    )
    file_resp = await routers.get_executor_workspace_artifact(
        task_id=42,
        executor_name="executor-original",
        binding_id="b" * 64,
        subtask_id="7",
        executor_namespace="wegent-pod",
        root_path="/workspace/42",
        path="outputs/report.md",
        offset=0,
        http_request=http_request,
    )
    assert file_resp.status_code == 200
    assert file_resp.body == b"".join(file_chunks)
    assert file_resp.media_type == "text/markdown"
    assert recorded_file["params"] == {
        "binding_id": "b" * 64,
        "task_id": "42",
        "subtask_id": "7",
        "root_path": "/workspace/42",
        "path": "outputs/report.md",
        "offset": 0,
    }


@pytest.mark.asyncio
async def test_workspace_artifact_prefers_sandbox_only_when_container_name_matches(
    mocker,
):
    sandbox = SimpleNamespace(
        base_url="http://sandbox.local:9000",
        container_name="sandbox-other",
        executor_namespace="default",
    )
    sandbox_manager = mocker.MagicMock()
    sandbox_manager.get_sandbox = mocker.AsyncMock(return_value=sandbox)
    mocker.patch(
        "executor_manager.services.sandbox.get_sandbox_manager",
        return_value=sandbox_manager,
    )
    mock_executor = mocker.MagicMock()
    mock_executor.get_container_address.return_value = {
        "status": "success",
        "base_url": "http://executor-declared.local:8080",
    }
    mocker.patch.object(
        routers.ExecutorDispatcher, "get_executor", return_value=mock_executor
    )

    mismatched = await routers._resolve_workspace_runtime_base_url(
        42,
        "executor-declared",
        executor_namespace="default",
        require_executor_match=True,
    )
    assert mismatched == "http://executor-declared.local:8080"

    sandbox.container_name = "executor-declared"
    matched = await routers._resolve_workspace_runtime_base_url(
        42,
        "executor-declared",
        executor_namespace="default",
        require_executor_match=True,
    )
    assert matched == "http://sandbox.local:9000"

    wrong_namespace = await routers._resolve_workspace_runtime_base_url(
        42, "executor-declared", executor_namespace="other", require_executor_match=True
    )
    assert wrong_namespace == "http://executor-declared.local:8080"

    sandbox.container_name = "sandbox-other"
    reused = await routers._resolve_workspace_runtime_base_url(
        42, "executor-declared", executor_namespace="default"
    )
    assert reused == "http://sandbox.local:9000"


@pytest.mark.asyncio
async def test_artifact_lookup_does_not_delete_an_unrelated_sandbox(
    mocker: MockerFixture,
) -> None:
    from executor_manager.services.sandbox.manager import SandboxManager

    sandbox = SimpleNamespace(
        sandbox_id="42",
        container_name="executor-active",
        base_url="http://active.local",
    )
    cached = {"42": sandbox}
    manager = object.__new__(SandboxManager)
    manager._repository = SimpleNamespace(
        load_sandbox=cached.get, delete_sandbox=cached.pop
    )
    manager._health_checker = SimpleNamespace(check_health_sync=lambda _: False)
    mocker.patch(
        "executor_manager.services.sandbox.get_sandbox_manager", return_value=manager
    )
    executor = mocker.MagicMock()
    executor.get_container_address.return_value = {
        "status": "success",
        "base_url": "http://declared.local",
    }
    mocker.patch.object(
        routers.ExecutorDispatcher, "get_executor", return_value=executor
    )
    _mock_stream_client(mocker, response=_FakeStreamResponse(chunks=[b"artifact"]))

    response = await routers.get_executor_workspace_artifact(
        task_id=42,
        executor_name="executor-original",
        binding_id="b" * 64,
        subtask_id="7",
        path="report.md",
    )

    assert response.body == b"artifact"
    assert cached == {"42": sandbox}
    executor.delete_executor.assert_not_called()


@pytest.mark.parametrize(
    ("upstream_status", "expected_status", "raw_body", "expected_detail"),
    [
        (400, 400, b'{"detail":"Invalid artifact path"}', "Invalid artifact path"),
        (403, 403, b'{"detail":"Binding mismatch"}', "Binding mismatch"),
        (404, 404, b'{"detail":"Artifact missing"}', "Artifact missing"),
        (404, 404, rb'{"detail":"\u4e2d\u6587\ud83d\ude00"}', "中文😀"),
        (413, 413, b'{"detail":"Artifact too large"}', "Artifact too large"),
        (500, 502, b"internal failure", "Remote artifact request failed"),
        (307, 502, b"", "Remote artifact request failed"),
        pytest.param(403, 403, b"[" * 20000 + b"]" * 20000, "[" * 200, id="deep-json"),
        pytest.param(
            404,
            404,
            rb'{"detail":"\ud800"}',
            r'{"detail":"\ud800"}',
            id="unpaired-surrogate",
        ),
        (
            404,
            404,
            httpx.ReadTimeout("error body timed out"),
            "Artifact request failed",
        ),
        (
            500,
            502,
            httpx.RemoteProtocolError("error body disconnected"),
            "Remote artifact request failed",
        ),
    ],
)
@pytest.mark.asyncio
async def test_workspace_artifact_preserves_client_status_and_maps_5xx_to_502(
    mocker: MockerFixture,
    upstream_status: int,
    expected_status: int,
    raw_body: bytes | httpx.RequestError,
    expected_detail: str,
) -> None:
    mocker.patch.object(
        routers,
        "_resolve_workspace_runtime_base_url",
        mocker.AsyncMock(return_value="http://executor.local:8000"),
    )
    _mock_stream_client(
        mocker,
        response=_FakeStreamResponse(status_code=upstream_status, chunks=[raw_body]),
    )
    with pytest.raises(routers.HTTPException) as exc_info:
        await routers.get_executor_workspace_artifact(
            task_id=42,
            executor_name="executor-1",
            binding_id="b" * 64,
            subtask_id="7",
            path="report.md",
        )
    assert exc_info.value.status_code == expected_status
    assert exc_info.value.detail == expected_detail


@pytest.mark.parametrize(
    ("upstream_status", "expected_status", "first_chunk", "expected_detail"),
    [
        (404, 404, b'{"detail":"Artifact missing"}', "Artifact missing"),
        (500, 502, b"internal failure", "Remote artifact request failed"),
    ],
)
@pytest.mark.asyncio
async def test_workspace_artifact_oversized_error_body_preserves_upstream_status(
    mocker: MockerFixture,
    upstream_status: int,
    expected_status: int,
    first_chunk: bytes,
    expected_detail: str,
) -> None:
    mocker.patch.object(
        routers,
        "_resolve_workspace_runtime_base_url",
        mocker.AsyncMock(return_value="http://executor.local:8000"),
    )
    preview_limit = 64 * 1024
    response = _FakeStreamResponse(
        status_code=upstream_status,
        headers={"content-length": str(preview_limit + len(first_chunk) + 1)},
        chunks=[
            first_chunk,
            b" " * preview_limit,
            AssertionError("error preview read past its limit"),
        ],
    )
    _mock_stream_client(mocker, response=response)

    with pytest.raises(routers.HTTPException) as exc_info:
        await routers.get_executor_workspace_artifact(
            task_id=42,
            executor_name="executor-1",
            binding_id="b" * 64,
            subtask_id="7",
            path="missing.bin",
        )

    assert exc_info.value.status_code == expected_status
    assert exc_info.value.detail == expected_detail
    assert response.consumed_chunks == 2


@pytest.mark.asyncio
async def test_workspace_artifact_maps_timeout_and_request_error_to_504_and_503(mocker):
    mocker.patch.object(
        routers,
        "_resolve_workspace_runtime_base_url",
        mocker.AsyncMock(return_value="http://executor.local:8000"),
    )
    _mock_stream_client(mocker, exc=httpx.ReadTimeout("timed out"))
    with pytest.raises(routers.HTTPException) as timeout_exc:
        await routers.get_executor_workspace_artifact(
            task_id=42,
            executor_name="executor-1",
            binding_id="b" * 64,
            subtask_id="7",
        )
    assert timeout_exc.value.status_code == 504

    _mock_stream_client(mocker, exc=httpx.ConnectError("connection refused"))
    with pytest.raises(routers.HTTPException) as connect_exc:
        await routers.get_executor_workspace_artifact(
            task_id=42,
            executor_name="executor-1",
            binding_id="b" * 64,
            subtask_id="7",
        )
    assert connect_exc.value.status_code == 503


@pytest.mark.asyncio
async def test_workspace_artifact_enforces_50_mib_limit_on_header_and_stream(mocker):
    mocker.patch.object(
        routers,
        "_resolve_workspace_runtime_base_url",
        mocker.AsyncMock(return_value="http://executor.local:8000"),
    )
    _mock_stream_client(
        mocker,
        response=_FakeStreamResponse(
            status_code=200,
            headers={
                "content-length": str(routers.MAX_WORKSPACE_ARTIFACT_FILE_BYTES + 1)
            },
            chunks=[b"x"],
        ),
    )
    with pytest.raises(routers.HTTPException) as header_exc:
        await routers.get_executor_workspace_artifact(
            task_id=42,
            executor_name="executor-1",
            binding_id="b" * 64,
            subtask_id="7",
            path="oversized.bin",
        )
    assert header_exc.value.status_code == 413

    half = (routers.MAX_WORKSPACE_ARTIFACT_FILE_BYTES // 2) + 1
    _mock_stream_client(
        mocker,
        response=_FakeStreamResponse(
            status_code=200,
            chunks=[b"a" * half, b"b" * half],
        ),
    )
    with pytest.raises(routers.HTTPException) as stream_exc:
        await routers.get_executor_workspace_artifact(
            task_id=42,
            executor_name="executor-1",
            binding_id="b" * 64,
            subtask_id="7",
            path="oversized-stream.bin",
        )
    assert stream_exc.value.status_code == 413
