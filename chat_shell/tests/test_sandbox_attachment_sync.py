# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Regression tests for preparing Chat attachments in the task sandbox."""

import httpx
import pytest

from chat_shell.services import sandbox_attachment_sync
from chat_shell.services.sandbox_attachment_sync import (
    sync_chat_attachments_to_sandbox,
)
from chat_shell.tools.sandbox._base import SandboxManager
from shared.models.execution import ExecutionRequest
from shared.utils.attachment_block import build_sandbox_path


class _FakeFiles:
    def __init__(self) -> None:
        self.directories: list[str] = []
        self.writes: list[tuple[str, bytes]] = []

    async def get_info(self, path: str) -> None:
        raise FileNotFoundError(path)

    async def make_dir(self, path: str) -> None:
        self.directories.append(path)

    async def write(self, path: str, content: bytes) -> None:
        self.writes.append((path, content))


class _FakeSandbox:
    def __init__(self) -> None:
        self.sandbox_id = "task-sandbox"
        self.files = _FakeFiles()


class _FakeManager:
    def __init__(self, sandbox: _FakeSandbox | None, error: str | None = None) -> None:
        self.sandbox = sandbox
        self.error = error
        self.calls: list[dict] = []

    async def get_or_create_sandbox(self, **kwargs):
        self.calls.append(kwargs)
        return self.sandbox, self.error


class _FakeAsyncClient:
    calls: list[tuple[str, dict[str, str]]] = []
    task_attachments: list[dict] = []

    def __init__(self, **kwargs) -> None:
        self.options = kwargs

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, traceback) -> None:
        return None

    async def get(self, url: str, headers: dict[str, str]) -> httpx.Response:
        self.calls.append((url, headers))
        if "/api/attachments/task/" in url:
            return httpx.Response(
                200,
                json=self.task_attachments,
                request=httpx.Request("GET", url),
            )
        return httpx.Response(
            200,
            content=b"name,value\nalpha,1\n",
            request=httpx.Request("GET", url),
        )


@pytest.fixture(autouse=True)
def _reset_fake_client() -> None:
    _FakeAsyncClient.calls = []
    _FakeAsyncClient.task_attachments = []


@pytest.mark.asyncio
async def test_syncs_attachment_before_sandbox_tools_can_read_it(monkeypatch) -> None:
    sandbox = _FakeSandbox()
    manager = _FakeManager(sandbox)
    manager_factory_calls: list[dict] = []

    def get_manager(cls, **kwargs):
        manager_factory_calls.append(kwargs)
        return manager

    monkeypatch.setattr(
        SandboxManager,
        "get_instance",
        classmethod(get_manager),
    )
    monkeypatch.setattr(sandbox_attachment_sync.httpx, "AsyncClient", _FakeAsyncClient)

    path = build_sandbox_path(100, 201, "热点复盘.csv")
    request = ExecutionRequest(
        task_id=100,
        subtask_id=202,
        user_subtask_id=201,
        user_id=3,
        user_name="alice",
        prompt=f"File Path(already in sandbox): {path}",
        skill_names=["sandbox"],
        skill_configs=[
            {
                "name": "sandbox",
                "config": {
                    "default_shell_type": "Agno",
                    "bot_config": [{"shell_type": "Agno"}],
                },
            }
        ],
        auth_token="task-token",
        backend_url="http://backend:8000",
        attachments=[
            {
                "id": 77,
                "original_filename": "热点复盘.csv",
                "mime_type": "text/csv",
                "file_size": 19,
                "subtask_id": 201,
            }
        ],
    )

    await sync_chat_attachments_to_sandbox(request)

    assert manager_factory_calls == [
        {
            "task_id": 100,
            "user_id": 3,
            "user_name": "alice",
            "bot_config": [{"shell_type": "Agno"}],
            "auth_token": "task-token",
            "skill_identity_token": "",
        }
    ]
    assert manager.calls == [
        {
            "shell_type": "Agno",
            "workspace_ref": None,
            "task_type": "sandbox",
        }
    ]
    assert _FakeAsyncClient.calls == [
        (
            "http://backend:8000/api/attachments/task/100/all",
            {"Authorization": "Bearer task-token"},
        ),
        (
            "http://backend:8000/api/attachments/77/executor-download",
            {"Authorization": "Bearer task-token"},
        ),
    ]
    assert sandbox.files.writes == [(path, b"name,value\nalpha,1\n")]
    assert request.attachments[0]["status"] == "success"
    assert request.attachments[0]["local_path"] == path
    assert "File Path(already in sandbox)" in request.prompt


@pytest.mark.asyncio
async def test_backend_url_with_api_suffix_is_not_doubled(monkeypatch) -> None:
    sandbox = _FakeSandbox()
    manager = _FakeManager(sandbox)
    monkeypatch.setattr(
        SandboxManager,
        "get_instance",
        classmethod(lambda cls, **kwargs: manager),
    )
    monkeypatch.setattr(sandbox_attachment_sync.httpx, "AsyncClient", _FakeAsyncClient)

    path = build_sandbox_path(100, 201, "report.csv")
    request = ExecutionRequest(
        task_id=100,
        subtask_id=202,
        user_subtask_id=201,
        user_id=3,
        user_name="alice",
        prompt=f"File Path(already in sandbox): {path}",
        skill_names=["sandbox"],
        auth_token="task-token",
        backend_url="http://backend:8000/api",
        attachments=[
            {
                "id": 77,
                "original_filename": "report.csv",
                "file_size": 19,
                "subtask_id": 201,
            }
        ],
    )

    await sync_chat_attachments_to_sandbox(request)

    assert _FakeAsyncClient.calls == [
        (
            "http://backend:8000/api/attachments/task/100/all",
            {"Authorization": "Bearer task-token"},
        ),
        (
            "http://backend:8000/api/attachments/77/executor-download",
            {"Authorization": "Bearer task-token"},
        ),
    ]
    assert request.attachments[0]["status"] == "success"


@pytest.mark.asyncio
async def test_failed_sync_stops_claiming_attachment_is_in_sandbox(monkeypatch) -> None:
    manager = _FakeManager(None, "sandbox unavailable")
    monkeypatch.setattr(
        SandboxManager,
        "get_instance",
        classmethod(lambda cls, **kwargs: manager),
    )
    monkeypatch.setattr(sandbox_attachment_sync.httpx, "AsyncClient", _FakeAsyncClient)

    path = build_sandbox_path(100, 201, "report.csv")
    request = ExecutionRequest(
        task_id=100,
        subtask_id=202,
        user_subtask_id=201,
        user_id=3,
        user_name="alice",
        prompt=f"File Path(already in sandbox): {path}",
        preload_skills=["sandbox"],
        auth_token="task-token",
        attachments=[{"id": 77, "original_filename": "report.csv"}],
    )

    await sync_chat_attachments_to_sandbox(request)

    assert request.attachments[0]["status"] == "failed"
    assert "File Path(already in sandbox)" not in request.prompt
    assert f"File Path(not synchronized): {path}" in request.prompt
    assert "attachment_url=/api/attachments/77/download" in request.prompt
    assert f"it will save to {path}" in request.prompt


@pytest.mark.asyncio
async def test_syncs_historical_task_attachments(monkeypatch) -> None:
    sandbox = _FakeSandbox()
    manager = _FakeManager(sandbox)
    monkeypatch.setattr(
        SandboxManager,
        "get_instance",
        classmethod(lambda cls, **kwargs: manager),
    )
    monkeypatch.setattr(sandbox_attachment_sync.httpx, "AsyncClient", _FakeAsyncClient)
    _FakeAsyncClient.task_attachments = [
        {
            "id": 76,
            "filename": "历史附件.txt",
            "mime_type": "text/plain",
            "file_size": 19,
            "subtask_id": 199,
        }
    ]
    path = build_sandbox_path(100, 199, "历史附件.txt")
    request = ExecutionRequest(
        task_id=100,
        subtask_id=202,
        user_subtask_id=201,
        user_id=3,
        user_name="alice",
        prompt="继续分析之前的附件",
        skill_names=["sandbox"],
        auth_token="task-token",
        backend_url="http://backend:8000",
    )

    await sync_chat_attachments_to_sandbox(request)

    assert _FakeAsyncClient.calls == [
        (
            "http://backend:8000/api/attachments/task/100/all",
            {"Authorization": "Bearer task-token"},
        ),
        (
            "http://backend:8000/api/attachments/76/executor-download",
            {"Authorization": "Bearer task-token"},
        ),
    ]
    assert sandbox.files.writes == [(path, b"name,value\nalpha,1\n")]
    assert request.attachments[0]["subtask_id"] == 199
    assert request.attachments[0]["local_path"] == path


@pytest.mark.asyncio
async def test_empty_task_attachment_list_does_not_create_sandbox(monkeypatch) -> None:
    def fail_if_called(cls, **kwargs):
        raise AssertionError("sandbox should not be created")

    monkeypatch.setattr(
        SandboxManager,
        "get_instance",
        classmethod(fail_if_called),
    )
    monkeypatch.setattr(sandbox_attachment_sync.httpx, "AsyncClient", _FakeAsyncClient)
    request = ExecutionRequest(
        task_id=100,
        subtask_id=202,
        prompt="plain chat",
        skill_names=["sandbox"],
        auth_token="task-token",
        backend_url="http://backend:8000",
    )

    await sync_chat_attachments_to_sandbox(request)

    assert request.attachments == []


@pytest.mark.asyncio
async def test_request_without_sandbox_skill_does_not_create_sandbox(
    monkeypatch,
) -> None:
    def fail_if_called(cls, **kwargs):
        raise AssertionError("sandbox should not be created")

    monkeypatch.setattr(
        SandboxManager,
        "get_instance",
        classmethod(fail_if_called),
    )
    request = ExecutionRequest(
        task_id=100,
        subtask_id=202,
        prompt="plain attachment",
        auth_token="task-token",
        attachments=[{"id": 77, "original_filename": "report.csv"}],
    )

    await sync_chat_attachments_to_sandbox(request)

    assert request.attachments == [{"id": 77, "original_filename": "report.csv"}]
