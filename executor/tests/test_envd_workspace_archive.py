# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import json
import shutil
import tarfile
from io import BytesIO
from pathlib import Path

import httpx
import pytest
from fastapi import FastAPI

from executor.envd.api import routes
from executor.envd.api.routes import register_rest_api


@pytest.mark.asyncio
async def test_archive_and_restore_includes_workspace_and_home_claude(
    tmp_path: Path, monkeypatch
):
    task_id = 1385
    upload_url = "https://minio.local/upload/workspace-archive"

    workspace_path = tmp_path / "workspace" / str(task_id)
    workspace_path.mkdir(parents=True)
    (workspace_path / ".claude").mkdir()
    (workspace_path / ".claude" / "workspace-memory.md").write_text(
        "workspace-context",
        encoding="utf-8",
    )
    (workspace_path / ".claude_session_id").write_text("session-id", encoding="utf-8")
    (workspace_path / ".git").mkdir()
    (workspace_path / ".git" / "HEAD").write_text(
        "ref: refs/heads/main",
        encoding="utf-8",
    )

    home_path = tmp_path / "home"
    home_path.mkdir(parents=True)
    (home_path / ".claude").mkdir()
    (home_path / ".claude" / "home-memory.md").write_text(
        "home-context",
        encoding="utf-8",
    )
    (home_path / ".claude.json").write_text(
        json.dumps({"theme": "dark"}),
        encoding="utf-8",
    )

    monkeypatch.setattr(routes, "get_workspace_path", lambda _: workspace_path)
    monkeypatch.setattr(routes, "get_home_path", lambda: home_path)

    archive_blob_store: dict[str, bytes] = {}

    async def _mock_upload_archive(upload_url: str, content: bytes) -> None:
        archive_blob_store[upload_url] = content

    async def _mock_download_archive(download_url: str) -> bytes:
        return archive_blob_store[download_url]

    monkeypatch.setattr(routes, "upload_archive_to_url", _mock_upload_archive)
    monkeypatch.setattr(routes, "download_archive_from_url", _mock_download_archive)

    app = FastAPI()
    register_rest_api(app)
    transport = httpx.ASGITransport(app=app)

    async with httpx.AsyncClient(
        transport=transport,
        base_url="http://testserver",
    ) as client:
        archive_response = await client.post(
            "/api/archive",
            json={
                "task_id": task_id,
                "upload_url": upload_url,
                "max_size_mb": 10,
            },
        )

        assert archive_response.status_code == 200
        archive_payload = archive_response.json()
        assert archive_payload["session_file_included"] is True
        assert archive_payload["git_included"] is True

        shutil.rmtree(workspace_path / ".claude")
        (workspace_path / ".claude_session_id").unlink()
        shutil.rmtree(home_path / ".claude")
        (home_path / ".claude.json").unlink()

        restore_response = await client.post(
            "/api/restore",
            json={
                "task_id": task_id,
                "download_url": upload_url,
            },
        )

        assert restore_response.status_code == 200
        restore_payload = restore_response.json()
        assert restore_payload["success"] is True
        assert restore_payload["session_restored"] is True
        assert restore_payload["git_restored"] is True

    assert (workspace_path / ".claude" / "workspace-memory.md").read_text(
        encoding="utf-8"
    ) == "workspace-context"
    assert (home_path / ".claude" / "home-memory.md").read_text(
        encoding="utf-8"
    ) == "home-context"
    assert json.loads((home_path / ".claude.json").read_text(encoding="utf-8")) == {
        "theme": "dark"
    }


@pytest.mark.asyncio
async def test_archive_returns_404_when_workspace_missing(tmp_path: Path, monkeypatch):
    task_id = 2468
    monkeypatch.setattr(
        routes, "get_workspace_path", lambda _: tmp_path / "workspace" / str(task_id)
    )

    app = FastAPI()
    register_rest_api(app)
    transport = httpx.ASGITransport(app=app)

    async with httpx.AsyncClient(
        transport=transport,
        base_url="http://testserver",
    ) as client:
        response = await client.post(
            "/api/archive",
            json={
                "task_id": task_id,
                "upload_url": "https://minio.local/upload/missing",
                "max_size_mb": 10,
            },
        )

    assert response.status_code == 404


@pytest.mark.asyncio
async def test_archive_enforces_max_size_and_excludes_large_directories(
    tmp_path: Path, monkeypatch
):
    task_id = 3579
    workspace_path = tmp_path / "workspace" / str(task_id)
    workspace_path.mkdir(parents=True)
    (workspace_path / "keep.txt").write_text("keep", encoding="utf-8")
    (workspace_path / "node_modules").mkdir()
    (workspace_path / "node_modules" / "huge.txt").write_text(
        "x" * 4096,
        encoding="utf-8",
    )

    monkeypatch.setattr(routes, "get_workspace_path", lambda _: workspace_path)
    monkeypatch.setattr(routes, "get_home_path", lambda: tmp_path / "home")

    archive_blob_store: dict[str, bytes] = {}

    async def _mock_upload_archive(upload_url: str, content: bytes) -> None:
        archive_blob_store[upload_url] = content

    monkeypatch.setattr(routes, "upload_archive_to_url", _mock_upload_archive)

    app = FastAPI()
    register_rest_api(app)
    transport = httpx.ASGITransport(app=app)

    async with httpx.AsyncClient(
        transport=transport,
        base_url="http://testserver",
    ) as client:
        ok_response = await client.post(
            "/api/archive",
            json={
                "task_id": task_id,
                "upload_url": "https://minio.local/upload/ok",
                "max_size_mb": 1,
            },
        )
        too_large_response = await client.post(
            "/api/archive",
            json={
                "task_id": task_id,
                "upload_url": "https://minio.local/upload/too-large",
                "max_size_mb": 0,
            },
        )

    assert ok_response.status_code == 200
    assert ok_response.json()["session_file_included"] is False
    assert ok_response.json()["git_included"] is False
    assert too_large_response.status_code == 413
    with tarfile.open(
        fileobj=BytesIO(archive_blob_store["https://minio.local/upload/ok"]),
        mode="r:gz",
    ) as tar:
        member_names = tar.getnames()

    assert "node_modules" not in member_names
    assert "keep.txt" in member_names


@pytest.mark.asyncio
async def test_restore_succeeds_without_home_payload(tmp_path: Path, monkeypatch):
    task_id = 8642
    upload_url = "https://minio.local/upload/no-home"

    workspace_path = tmp_path / "workspace" / str(task_id)
    workspace_path.mkdir(parents=True)
    (workspace_path / "keep.txt").write_text("keep", encoding="utf-8")
    home_path = tmp_path / "home"
    home_path.mkdir(parents=True)

    monkeypatch.setattr(routes, "get_workspace_path", lambda _: workspace_path)
    monkeypatch.setattr(routes, "get_home_path", lambda: home_path)

    archive_blob_store: dict[str, bytes] = {}

    async def _mock_upload_archive(upload_url: str, content: bytes) -> None:
        archive_blob_store[upload_url] = content

    async def _mock_download_archive(download_url: str) -> bytes:
        return archive_blob_store[download_url]

    monkeypatch.setattr(routes, "upload_archive_to_url", _mock_upload_archive)
    monkeypatch.setattr(routes, "download_archive_from_url", _mock_download_archive)

    app = FastAPI()
    register_rest_api(app)
    transport = httpx.ASGITransport(app=app)

    async with httpx.AsyncClient(
        transport=transport,
        base_url="http://testserver",
    ) as client:
        archive_response = await client.post(
            "/api/archive",
            json={
                "task_id": task_id,
                "upload_url": upload_url,
                "max_size_mb": 1,
            },
        )

        assert archive_response.status_code == 200

        restore_response = await client.post(
            "/api/restore",
            json={
                "task_id": task_id,
                "download_url": upload_url,
            },
        )

    assert restore_response.status_code == 200
    assert restore_response.json()["success"] is True
    assert restore_response.json()["session_restored"] is False
    assert restore_response.json()["git_restored"] is False
