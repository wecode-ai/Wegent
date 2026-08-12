# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for task-token attachment downloads in the sandbox skill."""

import json
from types import SimpleNamespace

import pytest

from init_data.skills.sandbox.download_attachment_tool import (
    SandboxDownloadAttachmentTool,
    _build_download_url,
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

    monkeypatch.setattr(
        SandboxDownloadAttachmentTool,
        "_get_sandbox_manager",
        lambda self: FakeManager(),
    )
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
            save_path="/home/user/report.csv",
        )
    )

    assert result["success"] is True
    assert "task-token" not in calls[0]["cmd"]
    assert "/home/user/report.csv" not in calls[0]["cmd"]
    assert calls[0]["envs"] == {
        "WEGENT_ATTACHMENT_TOKEN": "task-token",
        "WEGENT_ATTACHMENT_SAVE_PATH": "/home/user/report.csv",
        "WEGENT_ATTACHMENT_DOWNLOAD_URL": (
            "http://backend:8000/api/attachments/123/executor-download"
        ),
    }
