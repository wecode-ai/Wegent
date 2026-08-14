# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for task-token attachment downloads in the sandbox skill."""

import json
from types import SimpleNamespace

import httpx
import pytest

from init_data.skills.sandbox import download_attachment_tool
from init_data.skills.sandbox.download_attachment_tool import (
    SandboxDownloadAttachmentTool,
    _build_download_url,
    _resolve_attachment_sandbox_path,
)


def test_build_download_url_uses_executor_endpoint_for_attachment_url() -> None:
    assert (
        _build_download_url("/api/attachments/123/download", "http://backend:8000")
        == "http://backend:8000/api/attachments/123/executor-download"
    )
    assert (
        _build_download_url(
            "https://wegent.example/api/attachments/123/download?download=1",
            "http://backend:8000",
        )
        == "http://backend:8000/api/attachments/123/executor-download"
    )


def test_build_download_url_rejects_non_attachment_url() -> None:
    with pytest.raises(ValueError, match="Only Wegent attachment download URLs"):
        _build_download_url(
            "https://files.example/report.csv",
            "http://backend:8000",
        )


@pytest.mark.asyncio
async def test_download_uses_environment_for_credentials_and_paths(monkeypatch) -> None:
    calls: list[dict] = []
    metadata_calls: list[tuple[str, dict[str, str]]] = []

    class FakeFiles:
        async def make_dir(self, path: str) -> None:
            return None

        async def get_info(self, path: str) -> SimpleNamespace:
            return SimpleNamespace(size=4)

    class FakeCommands:
        async def run(self, **kwargs) -> SimpleNamespace:
            calls.append(kwargs)
            return SimpleNamespace(exit_code=0, stderr="")

    sandbox = SimpleNamespace(
        sandbox_id="sandbox-1",
        files=FakeFiles(),
        commands=FakeCommands(),
    )

    class FakeManager:
        async def get_or_create_sandbox(self, **kwargs):
            return sandbox, None

    class FakeAsyncClient:
        def __init__(self, **kwargs) -> None:
            self.options = kwargs

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, traceback) -> None:
            return None

        async def get(self, url: str, headers: dict[str, str]) -> httpx.Response:
            metadata_calls.append((url, headers))
            return httpx.Response(
                200,
                json=[
                    {
                        "id": 123,
                        "filename": "report.csv",
                        "subtask_id": 2,
                    }
                ],
                request=httpx.Request("GET", url),
            )

    monkeypatch.setattr(
        SandboxDownloadAttachmentTool,
        "_get_sandbox_manager",
        lambda self: FakeManager(),
    )
    monkeypatch.setattr(download_attachment_tool.httpx, "AsyncClient", FakeAsyncClient)
    tool = SandboxDownloadAttachmentTool(
        task_id=1,
        subtask_id=2,
        user_id=3,
        user_name="alice",
        auth_token="task-token",
        api_base_url="http://backend:8000",
    )

    result = json.loads(
        await tool._arun(
            attachment_url="/api/attachments/123/download",
        )
    )

    assert result["success"] is True
    assert result["file_path"] == "/home/user/1:executor:attachments/2/report.csv"
    assert metadata_calls == [
        (
            "http://backend:8000/api/attachments/task/1/all",
            {"Authorization": "Bearer task-token"},
        )
    ]
    assert "task-token" not in calls[0]["cmd"]
    assert "/home/user/1:executor:attachments/2/report.csv" not in calls[0]["cmd"]
    assert calls[0]["envs"] == {
        "WEGENT_ATTACHMENT_TOKEN": "task-token",
        "WEGENT_ATTACHMENT_SAVE_PATH": (
            "/home/user/1:executor:attachments/2/report.csv"
        ),
        "WEGENT_ATTACHMENT_DOWNLOAD_URL": (
            "http://backend:8000/api/attachments/123/executor-download"
        ),
    }


@pytest.mark.asyncio
async def test_resolve_path_rejects_attachment_from_another_task(monkeypatch) -> None:
    class FakeAsyncClient:
        def __init__(self, **kwargs) -> None:
            return None

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, traceback) -> None:
            return None

        async def get(self, url: str, headers: dict[str, str]) -> httpx.Response:
            return httpx.Response(
                200,
                json=[{"id": 456, "filename": "other.csv", "subtask_id": 2}],
                request=httpx.Request("GET", url),
            )

    monkeypatch.setattr(download_attachment_tool.httpx, "AsyncClient", FakeAsyncClient)

    with pytest.raises(ValueError, match="does not belong to this task"):
        await _resolve_attachment_sandbox_path(
            attachment_url="/api/attachments/123/download",
            api_base_url="http://backend:8000",
            auth_token="task-token",
            task_id=1,
            timeout_seconds=30,
        )
