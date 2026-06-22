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
async def test_executor_archive_and_restore_includes_workspace_and_claude_home(
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
    (home_path / "notes.md").write_text("home-notes", encoding="utf-8")
    (home_path / ".ssh").mkdir()
    (home_path / ".ssh" / "id_rsa").write_text("secret", encoding="utf-8")
    (home_path / ".npmrc").write_text("//registry/:_authToken=secret", encoding="utf-8")
    (home_path / ".cache").mkdir()
    (home_path / ".cache" / "large.bin").write_text("skip", encoding="utf-8")

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
        with tarfile.open(
            fileobj=BytesIO(archive_blob_store[upload_url]),
            mode="r:gz",
        ) as tar:
            member_names = tar.getnames()

        assert "workspace/.claude/workspace-memory.md" in member_names
        assert "workspace/.claude_session_id" in member_names
        assert "workspace/.git/HEAD" in member_names
        assert "home/.claude/home-memory.md" in member_names
        assert "home/.claude.json" in member_names
        assert "home/notes.md" not in member_names
        assert "home/.ssh/id_rsa" not in member_names
        assert "home/.npmrc" not in member_names
        assert "home/.cache" not in member_names

        shutil.rmtree(workspace_path / ".claude")
        (workspace_path / ".claude_session_id").unlink()
        shutil.rmtree(workspace_path / ".git")
        shutil.rmtree(home_path / ".claude")
        (home_path / ".claude.json").unlink()
        (home_path / "notes.md").unlink()

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
    assert (workspace_path / ".git" / "HEAD").read_text(
        encoding="utf-8"
    ) == "ref: refs/heads/main"
    assert (home_path / ".claude" / "home-memory.md").read_text(
        encoding="utf-8"
    ) == "home-context"
    assert json.loads((home_path / ".claude.json").read_text(encoding="utf-8")) == {
        "theme": "dark"
    }
    assert not (home_path / "notes.md").exists()


@pytest.mark.asyncio
async def test_restore_legacy_archive_without_workspace_prefix(
    tmp_path: Path, monkeypatch
):
    task_id = 5728299
    download_url = "https://minio.local/download/legacy-workspace-archive"

    workspace_path = tmp_path / "workspace" / str(task_id)
    home_path = tmp_path / "home"
    home_path.mkdir(parents=True)

    archive_buffer = BytesIO()
    with tarfile.open(fileobj=archive_buffer, mode="w:gz") as tar:
        workspace_file = b"legacy workspace content"
        workspace_info = tarfile.TarInfo("repo/README.md")
        workspace_info.size = len(workspace_file)
        tar.addfile(workspace_info, BytesIO(workspace_file))

        session_file = b"legacy-session-id"
        session_info = tarfile.TarInfo(".claude_session_id")
        session_info.size = len(session_file)
        tar.addfile(session_info, BytesIO(session_file))

        git_head = b"ref: refs/heads/main"
        git_info = tarfile.TarInfo(".git/HEAD")
        git_info.size = len(git_head)
        tar.addfile(git_info, BytesIO(git_head))

        home_memory = b"legacy home memory"
        home_memory_info = tarfile.TarInfo("__home__/.claude/home-memory.md")
        home_memory_info.size = len(home_memory)
        tar.addfile(home_memory_info, BytesIO(home_memory))

        home_config = json.dumps({"legacy": True}).encode("utf-8")
        home_config_info = tarfile.TarInfo("__home__/.claude.json")
        home_config_info.size = len(home_config)
        tar.addfile(home_config_info, BytesIO(home_config))

    async def _mock_download_archive(url: str) -> bytes:
        assert url == download_url
        return archive_buffer.getvalue()

    monkeypatch.setattr(routes, "get_workspace_path", lambda _: workspace_path)
    monkeypatch.setattr(routes, "get_home_path", lambda: home_path)
    monkeypatch.setattr(routes, "download_archive_from_url", _mock_download_archive)

    app = FastAPI()
    register_rest_api(app)
    transport = httpx.ASGITransport(app=app)

    async with httpx.AsyncClient(
        transport=transport,
        base_url="http://testserver",
    ) as client:
        restore_response = await client.post(
            "/api/restore",
            json={
                "task_id": task_id,
                "download_url": download_url,
            },
        )

    assert restore_response.status_code == 200
    restore_payload = restore_response.json()
    assert restore_payload["success"] is True
    assert restore_payload["session_restored"] is True
    assert restore_payload["git_restored"] is True

    assert (workspace_path / "repo" / "README.md").read_text(
        encoding="utf-8"
    ) == "legacy workspace content"
    assert (workspace_path / ".claude_session_id").read_text(
        encoding="utf-8"
    ) == "legacy-session-id"
    assert (workspace_path / ".git" / "HEAD").read_text(
        encoding="utf-8"
    ) == "ref: refs/heads/main"
    assert (home_path / ".claude" / "home-memory.md").read_text(
        encoding="utf-8"
    ) == "legacy home memory"
    assert json.loads((home_path / ".claude.json").read_text(encoding="utf-8")) == {
        "legacy": True
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

    assert "workspace/node_modules" not in member_names
    assert "workspace/keep.txt" in member_names


@pytest.mark.asyncio
async def test_sandbox_archive_and_restore_includes_home_and_workspace(
    tmp_path: Path, monkeypatch
):
    task_id = 4680
    upload_url = "https://minio.local/upload/sandbox-archive"

    home_path = tmp_path / "home"
    home_path.mkdir(parents=True)
    (home_path / "notes.md").write_text("home-notes", encoding="utf-8")
    (home_path / ".cache").mkdir()
    (home_path / ".cache" / "large.bin").write_text("skip", encoding="utf-8")

    workspace_path = tmp_path / "workspace" / str(task_id)
    workspace_path.mkdir(parents=True)
    (workspace_path / "project.txt").write_text("workspace-project", encoding="utf-8")
    (workspace_path / "node_modules").mkdir()
    (workspace_path / "node_modules" / "skip.txt").write_text(
        "skip",
        encoding="utf-8",
    )

    monkeypatch.setattr(routes, "get_sandbox_home_path", lambda: home_path)
    monkeypatch.setattr(routes, "get_workspace_path", lambda _: workspace_path)

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
                "runtime_type": "sandbox",
            },
        )

        assert archive_response.status_code == 200
        with tarfile.open(
            fileobj=BytesIO(archive_blob_store[upload_url]),
            mode="r:gz",
        ) as tar:
            member_names = tar.getnames()

        assert "home/notes.md" in member_names
        assert "workspace/project.txt" in member_names
        assert "home/.cache" not in member_names
        assert "workspace/node_modules" not in member_names

        (home_path / "notes.md").unlink()
        (workspace_path / "project.txt").unlink()

        restore_response = await client.post(
            "/api/restore",
            json={
                "task_id": task_id,
                "download_url": upload_url,
                "runtime_type": "sandbox",
            },
        )

    assert restore_response.status_code == 200
    assert (home_path / "notes.md").read_text(encoding="utf-8") == "home-notes"
    assert (workspace_path / "project.txt").read_text(
        encoding="utf-8"
    ) == "workspace-project"


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


@pytest.mark.asyncio
async def test_executor_archive_excludes_code_server_runtime_state(
    tmp_path: Path, monkeypatch
):
    task_id = 9753
    upload_url = "https://minio.local/upload/code-server"

    workspace_path = tmp_path / "workspace" / str(task_id)
    workspace_path.mkdir(parents=True)
    (workspace_path / "keep.txt").write_text("keep", encoding="utf-8")

    home_path = tmp_path / "home"
    cert_path = home_path / ".local" / "share" / "code-server" / "cert"
    cert_path.mkdir(parents=True)
    (cert_path / "tls.crt").write_text("runtime-cert", encoding="utf-8")
    (home_path / "notes.md").write_text("home-notes", encoding="utf-8")

    monkeypatch.setattr(routes, "get_workspace_path", lambda _: workspace_path)
    monkeypatch.setattr(routes, "get_home_path", lambda: home_path)

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
        archive_response = await client.post(
            "/api/archive",
            json={
                "task_id": task_id,
                "upload_url": upload_url,
                "max_size_mb": 10,
            },
        )

    assert archive_response.status_code == 200
    with tarfile.open(
        fileobj=BytesIO(archive_blob_store[upload_url]),
        mode="r:gz",
    ) as tar:
        member_names = tar.getnames()

    assert "home/notes.md" not in member_names
    assert "workspace/keep.txt" in member_names
    assert "home/.local/share/code-server/cert/tls.crt" not in member_names


@pytest.mark.asyncio
async def test_restore_skips_code_server_runtime_members_from_old_archives(
    tmp_path: Path, monkeypatch
):
    task_id = 9764
    download_url = "https://minio.local/download/old-code-server"

    workspace_path = tmp_path / "workspace" / str(task_id)
    workspace_path.mkdir(parents=True)
    home_path = tmp_path / "home"
    home_path.mkdir(parents=True)

    archive_buffer = BytesIO()
    with tarfile.open(fileobj=archive_buffer, mode="w:gz") as tar:
        keep_bytes = b"restored"
        keep_info = tarfile.TarInfo("workspace/keep.txt")
        keep_info.size = len(keep_bytes)
        tar.addfile(keep_info, BytesIO(keep_bytes))

        cert_bytes = b"runtime-cert"
        cert_info = tarfile.TarInfo("home/.local/share/code-server/cert/tls.crt")
        cert_info.size = len(cert_bytes)
        tar.addfile(cert_info, BytesIO(cert_bytes))

        claude_bytes = b"claude-home"
        claude_info = tarfile.TarInfo("home/.claude/home-memory.md")
        claude_info.size = len(claude_bytes)
        tar.addfile(claude_info, BytesIO(claude_bytes))

        ssh_bytes = b"secret"
        ssh_info = tarfile.TarInfo("home/.ssh/id_rsa")
        ssh_info.size = len(ssh_bytes)
        tar.addfile(ssh_info, BytesIO(ssh_bytes))

    async def _mock_download_archive(download_url: str) -> bytes:
        return archive_buffer.getvalue()

    monkeypatch.setattr(routes, "get_workspace_path", lambda _: workspace_path)
    monkeypatch.setattr(routes, "get_home_path", lambda: home_path)
    monkeypatch.setattr(routes, "download_archive_from_url", _mock_download_archive)

    app = FastAPI()
    register_rest_api(app)
    transport = httpx.ASGITransport(app=app)

    async with httpx.AsyncClient(
        transport=transport,
        base_url="http://testserver",
    ) as client:
        restore_response = await client.post(
            "/api/restore",
            json={
                "task_id": task_id,
                "download_url": download_url,
            },
        )

    assert restore_response.status_code == 200
    assert (workspace_path / "keep.txt").read_text(encoding="utf-8") == "restored"
    assert (home_path / ".claude" / "home-memory.md").read_text(
        encoding="utf-8"
    ) == "claude-home"
    assert not (home_path / ".local" / "share" / "code-server").exists()
    assert not (home_path / ".ssh").exists()


def test_sandbox_home_path_is_not_process_home(monkeypatch):
    """Sandbox archives must target the user home, not the envd process home."""
    monkeypatch.setenv("HOME", "/root")

    assert routes.get_home_path() == Path("/root")
    assert routes.get_sandbox_home_path() == Path("/home/user")
