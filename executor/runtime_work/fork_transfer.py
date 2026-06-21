# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Archive transport helpers for runtime-native task forks."""

import asyncio
import contextlib
import os
import socket
import tarfile
import tempfile
import threading
import time
import uuid
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Optional

import httpx

from executor.config import config
from executor.services.workspace_archive_restore import restore_archive_content
from shared.logger import setup_logger

logger = setup_logger("runtime_work_fork_transfer")

TRANSFER_TTL_SECONDS = 900
TRANSFER_PATH_PREFIX = "/runtime-task-transfers/"
TRANSFER_UPLOAD_PATH_PREFIX = "/runtime-task-transfer-uploads/"
HOME_ARCHIVE_PREFIX = "home"
WORKSPACE_ARCHIVE_PREFIX = "workspace"
HOME_SESSION_ALLOWLIST = (
    ".claude",
    ".claude.json",
    ".codex/sessions",
    ".codex/archived_sessions",
    ".codex/state",
)


@dataclass(frozen=True)
class PreparedArchive:
    """Prepared archive transport locations."""

    archive_path: Path
    direct_urls: list[str]
    size_bytes: int


_server_lock = threading.Lock()
_server: Optional[ThreadingHTTPServer] = None
_server_thread: Optional[threading.Thread] = None
_transfers: dict[str, tuple[Path, str, float]] = {}
_incoming_transfers: dict[str, tuple[Path, str, float]] = {}


async def prepare_archive_transfer(
    *,
    workspace_path: str,
    transfer_id: str,
    upload_url: Optional[str],
) -> PreparedArchive:
    """Create a workspace/session archive and expose it directly with storage fallback."""

    archive_path = create_runtime_fork_archive(workspace_path)
    token = uuid.uuid4().hex
    direct_urls = register_direct_archive(transfer_id, archive_path, token)
    if upload_url:
        await upload_archive(upload_url, archive_path)
    return PreparedArchive(
        archive_path=archive_path,
        direct_urls=direct_urls,
        size_bytes=archive_path.stat().st_size,
    )


async def upload_registered_archive(*, transfer_id: str, upload_url: str) -> int:
    """Upload a previously prepared direct-transfer archive to object storage."""

    record = _transfers.get(transfer_id)
    if record is None:
        raise ValueError("Fork transfer is no longer available")
    archive_path, _token, expires_at = record
    if time.time() > expires_at:
        _cleanup_transfer(transfer_id)
        raise ValueError("Fork transfer has expired")
    await upload_archive(upload_url, archive_path)
    return archive_path.stat().st_size


async def upload_registered_archive_to_first_available_url(
    *,
    transfer_id: str,
    upload_urls: list[str],
) -> tuple[str, int]:
    """Upload a prepared archive to the first reachable direct receiver URL."""

    record = _transfers.get(transfer_id)
    if record is None:
        raise ValueError("Fork transfer is no longer available")
    archive_path, _token, expires_at = record
    if time.time() > expires_at:
        _cleanup_transfer(transfer_id)
        raise ValueError("Fork transfer has expired")
    uploaded_url = await upload_archive_to_first_available_url(
        upload_urls, archive_path
    )
    return uploaded_url, archive_path.stat().st_size


def register_direct_upload_receiver(transfer_id: str, token: str) -> list[str]:
    """Register a one-time direct upload receiver for target-side import."""

    server = _ensure_direct_server()
    fd, path = tempfile.mkstemp(
        prefix="wegent-runtime-fork-incoming-", suffix=".tar.gz"
    )
    os.close(fd)
    archive_path = Path(path)
    expires_at = time.time() + TRANSFER_TTL_SECONDS
    _incoming_transfers[transfer_id] = (archive_path, token, expires_at)
    cleanup_timer = threading.Timer(
        TRANSFER_TTL_SECONDS,
        lambda: _cleanup_incoming_transfer(transfer_id),
    )
    cleanup_timer.daemon = True
    cleanup_timer.start()
    port = int(server.server_address[1])
    urls = []
    for host in _candidate_hosts():
        urls.append(
            f"http://{host}:{port}{TRANSFER_UPLOAD_PATH_PREFIX}{transfer_id}?token={token}"
        )
    return urls


async def restore_fork_package_archive(
    *,
    archive: dict[str, Any],
    workspace_path: str,
) -> None:
    """Restore archive from direct URL first, then object storage fallback."""

    local_transfer_id = archive.get("localTransferId") or archive.get(
        "receiverTransferId"
    )
    if isinstance(local_transfer_id, str) and local_transfer_id.strip():
        if _restore_incoming_transfer(local_transfer_id, workspace_path):
            return

    archive_bytes = await _download_archive_bytes(archive)
    restore_archive_content(
        archive_content=archive_bytes,
        workspace_path=Path(workspace_path),
        home_path=Path.home(),
    )


def create_runtime_fork_archive(workspace_path: str) -> Path:
    """Create a tar.gz archive with workspace files and runtime session metadata."""

    normalized_workspace = Path(workspace_path).expanduser().resolve()
    if not normalized_workspace.is_dir():
        raise ValueError(f"Workspace not found: {workspace_path}")

    fd, path = tempfile.mkstemp(prefix="wegent-runtime-fork-", suffix=".tar.gz")
    os.close(fd)
    archive_path = Path(path)
    with tarfile.open(archive_path, "w:gz") as archive:
        _add_directory_children(
            archive,
            source=normalized_workspace,
            prefix=WORKSPACE_ARCHIVE_PREFIX,
        )
        _add_home_session_members(archive, Path.home())
    return archive_path


def register_direct_archive(
    transfer_id: str, archive_path: Path, token: str
) -> list[str]:
    """Register an archive for one-time direct download."""

    server = _ensure_direct_server()
    expires_at = time.time() + TRANSFER_TTL_SECONDS
    _transfers[transfer_id] = (archive_path, token, expires_at)
    cleanup_timer = threading.Timer(
        TRANSFER_TTL_SECONDS,
        lambda: _cleanup_transfer(transfer_id),
    )
    cleanup_timer.daemon = True
    cleanup_timer.start()
    port = int(server.server_address[1])
    urls = []
    for host in _candidate_hosts():
        urls.append(
            f"http://{host}:{port}{TRANSFER_PATH_PREFIX}{transfer_id}?token={token}"
        )
    return urls


async def upload_archive(upload_url: str, archive_path: Path) -> None:
    """Upload archive bytes directly to object storage via presigned URL."""

    async with httpx.AsyncClient(timeout=300.0) as client:
        with archive_path.open("rb") as handle:
            response = await client.put(
                upload_url,
                content=handle.read(),
                headers={"Content-Type": "application/gzip"},
            )
        response.raise_for_status()


async def upload_archive_to_first_available_url(
    urls: list[str],
    archive_path: Path,
) -> str:
    """Upload archive to the first reachable direct receiver URL."""

    last_error: Optional[Exception] = None
    for url in urls:
        try:
            await upload_archive(url, archive_path)
            return url
        except Exception as exc:
            last_error = exc
            logger.info("Runtime fork direct upload failed, trying next URL")
    if last_error is not None:
        raise last_error
    raise ValueError("No direct upload URL is available")


async def _download_archive_bytes(archive: dict[str, Any]) -> bytes:
    direct_urls = archive.get("directUrls")
    if isinstance(direct_urls, list):
        for url in direct_urls:
            if not isinstance(url, str) or not url.strip():
                continue
            with contextlib.suppress(Exception):
                return await _download_url(url)
            logger.info("Runtime fork direct download failed, trying next URL")

    download_url = archive.get("downloadUrl")
    if isinstance(download_url, str) and download_url.strip():
        return await _download_url(download_url)
    raise ValueError("Fork package does not include a usable archive URL")


async def _download_url(url: str) -> bytes:
    async with httpx.AsyncClient(timeout=300.0) as client:
        response = await client.get(url)
        response.raise_for_status()
        return response.content


def _ensure_direct_server() -> ThreadingHTTPServer:
    global _server, _server_thread
    with _server_lock:
        if _server is not None:
            return _server
        _server = ThreadingHTTPServer(("0.0.0.0", 0), _TransferRequestHandler)
        _server_thread = threading.Thread(
            target=_server.serve_forever,
            name="runtime-fork-transfer-server",
            daemon=True,
        )
        _server_thread.start()
        return _server


class _TransferRequestHandler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        transfer_id, token = _request_transfer_id_and_token(
            self.path,
            TRANSFER_PATH_PREFIX,
        )
        record = _transfers.get(transfer_id)
        if record is None:
            self.send_error(404)
            return
        archive_path, expected_token, expires_at = record
        if token != expected_token or time.time() > expires_at:
            self.send_error(403)
            return
        if not archive_path.is_file():
            self.send_error(404)
            return

        self.send_response(200)
        self.send_header("Content-Type", "application/gzip")
        self.send_header("Content-Length", str(archive_path.stat().st_size))
        self.end_headers()
        with archive_path.open("rb") as handle:
            while chunk := handle.read(1024 * 1024):
                self.wfile.write(chunk)

    def do_PUT(self) -> None:
        transfer_id, token = _request_transfer_id_and_token(
            self.path,
            TRANSFER_UPLOAD_PATH_PREFIX,
        )
        record = _incoming_transfers.get(transfer_id)
        if record is None:
            self.send_error(404)
            return
        archive_path, expected_token, expires_at = record
        if token != expected_token or time.time() > expires_at:
            self.send_error(403)
            return
        content_length = self.headers.get("Content-Length")
        if content_length is None or not content_length.isdigit():
            self.send_error(411)
            return

        remaining = int(content_length)
        with archive_path.open("wb") as handle:
            while remaining > 0:
                chunk = self.rfile.read(min(1024 * 1024, remaining))
                if not chunk:
                    self.send_error(400)
                    return
                handle.write(chunk)
                remaining -= len(chunk)

        self.send_response(204)
        self.end_headers()

    def log_message(self, _format: str, *args: Any) -> None:
        return


def _request_transfer_id_and_token(path: str, prefix: str) -> tuple[str, str]:
    transfer_id = path.split("?", maxsplit=1)[0].removeprefix(prefix)
    token = ""
    if "?" in path:
        query = path.split("?", maxsplit=1)[1]
        for part in query.split("&"):
            key, _, value = part.partition("=")
            if key == "token":
                token = value
                break
    return transfer_id, token


def _cleanup_transfer(transfer_id: str) -> None:
    record = _transfers.pop(transfer_id, None)
    if record is None:
        return
    archive_path, _token, _expires_at = record
    with contextlib.suppress(OSError):
        archive_path.unlink()


def _cleanup_incoming_transfer(transfer_id: str) -> None:
    record = _incoming_transfers.pop(transfer_id, None)
    if record is None:
        return
    archive_path, _token, _expires_at = record
    with contextlib.suppress(OSError):
        archive_path.unlink()


def _restore_incoming_transfer(transfer_id: str, workspace_path: str) -> bool:
    record = _incoming_transfers.get(transfer_id)
    if record is None:
        return False
    archive_path, _token, expires_at = record
    if time.time() > expires_at or not archive_path.is_file():
        _cleanup_incoming_transfer(transfer_id)
        return False
    restore_archive_content(
        archive_content=archive_path.read_bytes(),
        workspace_path=Path(workspace_path),
        home_path=Path.home(),
    )
    _cleanup_incoming_transfer(transfer_id)
    return True


def _candidate_hosts() -> list[str]:
    hosts = []
    configured = getattr(config, "RUNTIME_TRANSFER_HOST", None)
    if isinstance(configured, str) and configured.strip():
        hosts.append(configured.strip())
    with contextlib.suppress(OSError):
        hostname = socket.gethostname()
        host = socket.gethostbyname(hostname)
        if host and not host.startswith("127."):
            hosts.append(host)
    hosts.append("127.0.0.1")
    return list(dict.fromkeys(hosts))


def _add_directory_children(
    archive: tarfile.TarFile,
    *,
    source: Path,
    prefix: str,
) -> None:
    for item in source.iterdir():
        if _should_exclude(item):
            continue
        archive.add(str(item), arcname=f"{prefix}/{item.name}")


def _add_home_session_members(archive: tarfile.TarFile, home: Path) -> None:
    for relative_name in HOME_SESSION_ALLOWLIST:
        path = home / relative_name
        if not path.exists():
            continue
        archive.add(str(path), arcname=f"{HOME_ARCHIVE_PREFIX}/{relative_name}")


def _should_exclude(path: Path) -> bool:
    return path.name in {
        "node_modules",
        ".venv",
        "venv",
        "__pycache__",
        "dist",
        "build",
        "target",
    }
