# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Archive transport helpers for runtime-native task forks."""

import asyncio
import contextlib
import hashlib
import hmac
import io
import json
import os
import socket
import sqlite3
import subprocess
import tarfile
import tempfile
import threading
import time
import uuid
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Optional
from urllib.parse import parse_qs, urlsplit

import httpx

from executor.config import config
from executor.services.workspace_archive_restore import restore_archive_content
from shared.logger import setup_logger

logger = setup_logger("runtime_work_fork_transfer")

TRANSFER_TTL_SECONDS = 900
TRANSFER_PATH_PREFIX = "/runtime-task-transfers/"
TRANSFER_UPLOAD_PATH_PREFIX = "/runtime-task-transfer-uploads/"
DIRECT_TRANSFER_BIND_HOST = "0.0.0.0"
ARCHIVE_HTTP_TIMEOUT_SECONDS = 300.0
ARCHIVE_IO_CHUNK_BYTES = 1024 * 1024
TRANSFER_TOKEN_HEADER = "X-Wegent-Transfer-Token"
TRANSFER_PROOF_HEADER = "X-Wegent-Transfer-Proof"
HOME_ARCHIVE_PREFIX = "home"
RUNTIME_FORK_ARCHIVE_PREFIX = "runtime-fork"
RUNTIME_FORK_METADATA_MEMBER = f"{RUNTIME_FORK_ARCHIVE_PREFIX}/metadata.json"
RUNTIME_FORK_PATCH_MEMBER = f"{RUNTIME_FORK_ARCHIVE_PREFIX}/git.patch"
RUNTIME_FORK_UNTRACKED_PREFIX = f"{RUNTIME_FORK_ARCHIVE_PREFIX}/untracked"
RUNTIME_FORK_CODEX_STATE_MEMBER = f"{RUNTIME_FORK_ARCHIVE_PREFIX}/codex-state.json"
CODEX_STATE_RELATIVE_PATH = ".codex/sqlite/state_5.sqlite"
ARCHIVE_EXCLUDED_NAMES = {
    ".DS_Store",
    ".git",
    ".hg",
    ".mypy_cache",
    ".next",
    ".pytest_cache",
    ".ruff_cache",
    ".svn",
    ".turbo",
    "__pycache__",
    "build",
    "coverage",
    "dist",
    "node_modules",
    "target",
    "venv",
    ".venv",
}


@dataclass(frozen=True)
class PreparedArchive:
    """Prepared archive transport locations."""

    archive_path: Path
    direct_urls: list[str]
    direct_token: str
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
    session_paths: Optional[list[str]] = None,
    direct_hosts: Optional[list[str]] = None,
    include_workspace: bool = True,
    codex_thread_id: Optional[str] = None,
) -> PreparedArchive:
    """Create a workspace/session archive and expose it directly with storage fallback."""

    archive_path = await asyncio.to_thread(
        create_runtime_fork_archive,
        workspace_path,
        session_paths=session_paths,
        include_workspace=include_workspace,
        codex_thread_id=codex_thread_id,
    )
    token = uuid.uuid4().hex
    direct_urls = register_direct_archive(
        transfer_id,
        archive_path,
        token,
        direct_hosts=direct_hosts,
    )
    if upload_url:
        await upload_archive(upload_url, archive_path)
    return PreparedArchive(
        archive_path=archive_path,
        direct_urls=direct_urls,
        direct_token=token,
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
    upload_token: Optional[str] = None,
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
        upload_urls,
        archive_path,
        token=upload_token,
    )
    return uploaded_url, archive_path.stat().st_size


def register_direct_upload_receiver(
    transfer_id: str,
    token: str,
    direct_hosts: Optional[list[str]] = None,
) -> list[str]:
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
    bind_host = str(server.server_address[0])
    urls = []
    for host in _candidate_hosts(bind_host, direct_hosts=direct_hosts):
        urls.append(
            f"http://{_format_url_host(host)}:{port}{TRANSFER_UPLOAD_PATH_PREFIX}{transfer_id}"
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
    restore_runtime_fork_archive(
        archive_content=archive_bytes,
        workspace_path=Path(workspace_path),
        home_path=Path.home(),
    )


def create_runtime_fork_archive(
    workspace_path: str,
    *,
    session_paths: Optional[list[str]] = None,
    include_workspace: bool = True,
    codex_thread_id: Optional[str] = None,
) -> Path:
    """Create a tar.gz archive with workspace files and runtime session metadata."""

    normalized_workspace = Path(workspace_path).expanduser().resolve()
    if include_workspace and not normalized_workspace.is_dir():
        raise ValueError(f"Workspace not found: {workspace_path}")

    fd, path = tempfile.mkstemp(prefix="wegent-runtime-fork-", suffix=".tar.gz")
    os.close(fd)
    archive_path = Path(path)
    home = Path.home()
    codex_state = _export_codex_state(home, codex_thread_id)
    archive_session_paths = list(session_paths or [])
    rollout_relative_path = (
        codex_state.get("rolloutRelativePath")
        if isinstance(codex_state, dict)
        else None
    )
    if isinstance(rollout_relative_path, str) and rollout_relative_path.strip():
        archive_session_paths.append(str(home / rollout_relative_path))
    with tarfile.open(archive_path, "w:gz") as archive:
        if include_workspace:
            _add_git_patch_members(
                archive,
                source=normalized_workspace,
            )
        else:
            _add_bytes_member(
                archive,
                RUNTIME_FORK_METADATA_MEMBER,
                json.dumps(
                    {"type": "session_only"},
                    ensure_ascii=False,
                    sort_keys=True,
                ).encode("utf-8"),
            )
        _add_home_session_members(archive, home, session_paths=archive_session_paths)
        if codex_state:
            _add_bytes_member(
                archive,
                RUNTIME_FORK_CODEX_STATE_MEMBER,
                json.dumps(codex_state, ensure_ascii=False, sort_keys=True).encode(
                    "utf-8"
                ),
            )
    return archive_path


def restore_runtime_fork_archive(
    *,
    archive_content: bytes,
    workspace_path: Path,
    home_path: Path,
) -> None:
    """Restore a git patch fork package into a target workspace."""

    with tarfile.open(fileobj=io.BytesIO(archive_content), mode="r:gz") as archive:
        metadata = _read_runtime_fork_metadata(archive)
        archive_type = metadata.get("type")
        if archive_type not in {"git_patch", "session_only"}:
            raise ValueError("Unsupported runtime fork archive format")
        if archive_type == "git_patch":
            base_commit = str(metadata.get("baseCommit") or "").strip()
            if not base_commit:
                raise ValueError("Runtime fork archive is missing baseCommit")
            patch_bytes = _read_archive_member_bytes(archive, RUNTIME_FORK_PATCH_MEMBER)
            repository_root = _git_repository_root(
                workspace_path.expanduser().resolve()
            )
            if repository_root is None:
                raise ValueError("Target workspace must be a Git repository")

            _ensure_git_commit_available(repository_root, base_commit)
            _run_git_required(
                repository_root,
                [
                    "-c",
                    "advice.detachedHead=false",
                    "checkout",
                    "--force",
                    "--detach",
                    base_commit,
                ],
            )
            _run_git_required(repository_root, ["clean", "-fd"])
            if patch_bytes.strip():
                _run_git_required_bytes(
                    repository_root,
                    ["apply", "--binary", "--whitespace=nowarn"],
                    input_bytes=patch_bytes,
                )
            _extract_runtime_fork_untracked(archive, repository_root)

    restore_archive_content(
        archive_content=archive_content,
        workspace_path=workspace_path,
        home_path=home_path,
    )
    _restore_codex_state(
        archive_content=archive_content,
        workspace_path=workspace_path,
        home_path=home_path,
    )


def register_direct_archive(
    transfer_id: str,
    archive_path: Path,
    token: str,
    direct_hosts: Optional[list[str]] = None,
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
    bind_host = str(server.server_address[0])
    urls = []
    for host in _candidate_hosts(bind_host, direct_hosts=direct_hosts):
        urls.append(
            f"http://{_format_url_host(host)}:{port}{TRANSFER_PATH_PREFIX}{transfer_id}"
        )
    return urls


async def upload_archive(
    upload_url: str,
    archive_path: Path,
    *,
    token: Optional[str] = None,
) -> None:
    """Upload archive bytes directly to object storage via presigned URL."""

    async with httpx.AsyncClient(timeout=ARCHIVE_HTTP_TIMEOUT_SECONDS) as client:
        headers = {
            "Content-Type": "application/gzip",
            "Content-Length": str(archive_path.stat().st_size),
        }
        if token:
            headers[TRANSFER_TOKEN_HEADER] = token
        response = await client.put(
            upload_url,
            content=_iter_archive_chunks(archive_path),
            headers=headers,
        )
        response.raise_for_status()


async def _iter_archive_chunks(archive_path: Path):
    with archive_path.open("rb") as handle:
        while True:
            chunk = await asyncio.to_thread(handle.read, ARCHIVE_IO_CHUNK_BYTES)
            if not chunk:
                break
            yield chunk


async def upload_archive_to_first_available_url(
    urls: list[str],
    archive_path: Path,
    *,
    token: Optional[str] = None,
) -> str:
    """Upload archive to the first reachable direct receiver URL."""

    last_error: Optional[Exception] = None
    for url in urls:
        try:
            if token:
                await _verify_direct_transfer_peer(url, token)
            await upload_archive(url, archive_path, token=token)
            return url
        except Exception as exc:
            last_error = exc
            logger.info(
                "Runtime fork direct upload failed, trying next URL: url=%s error=%s",
                url,
                repr(exc),
            )
    if last_error is not None:
        raise last_error
    raise ValueError("No direct upload URL is available")


async def _download_archive_bytes(archive: dict[str, Any]) -> bytes:
    direct_urls = archive.get("directUrls")
    direct_token = archive.get("directToken")
    if isinstance(direct_urls, list):
        for url in direct_urls:
            if not isinstance(url, str) or not url.strip():
                continue
            try:
                if isinstance(direct_token, str) and direct_token.strip():
                    await _verify_direct_transfer_peer(url, direct_token)
                    return await _download_url(url, token=direct_token)
                return await _download_url(url)
            except Exception as exc:
                logger.info(
                    "Runtime fork direct download failed, trying next URL: "
                    "url=%s error=%s",
                    url,
                    repr(exc),
                )

    download_url = archive.get("downloadUrl")
    if isinstance(download_url, str) and download_url.strip():
        return await _download_url(download_url)
    raise ValueError("Fork package does not include a usable archive URL")


async def _download_url(url: str, *, token: Optional[str] = None) -> bytes:
    async with httpx.AsyncClient(timeout=ARCHIVE_HTTP_TIMEOUT_SECONDS) as client:
        headers = {TRANSFER_TOKEN_HEADER: token} if token else None
        response = await client.get(url, headers=headers)
        response.raise_for_status()
        return response.content


async def _verify_direct_transfer_peer(url: str, token: str) -> None:
    transfer_id = _transfer_id_from_url(url)
    if not transfer_id:
        raise ValueError("Direct transfer URL is missing transfer id")
    expected_proof = _transfer_proof(transfer_id, token)
    async with httpx.AsyncClient(timeout=ARCHIVE_HTTP_TIMEOUT_SECONDS) as client:
        response = await client.get(url, params={"probe": "1"})
        response.raise_for_status()
    received_proof = response.headers.get(TRANSFER_PROOF_HEADER, "")
    if not hmac.compare_digest(received_proof, expected_proof):
        raise ValueError("Direct transfer peer proof mismatch")


def _ensure_direct_server() -> ThreadingHTTPServer:
    global _server, _server_thread
    with _server_lock:
        if _server is not None:
            return _server
        _server = ThreadingHTTPServer(
            (_direct_transfer_bind_host(), 0),
            _TransferRequestHandler,
        )
        _server_thread = threading.Thread(
            target=_server.serve_forever,
            name="runtime-fork-transfer-server",
            daemon=True,
        )
        _server_thread.start()
        return _server


class _TransferRequestHandler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        if self.path.split("?", maxsplit=1)[0].startswith(TRANSFER_UPLOAD_PATH_PREFIX):
            self._handle_probe(TRANSFER_UPLOAD_PATH_PREFIX, _incoming_transfers)
            return

        transfer_id, query = _request_transfer_id_and_query(
            self.path,
            TRANSFER_PATH_PREFIX,
        )
        record = _transfers.get(transfer_id)
        if record is None:
            self.send_error(404)
            return
        archive_path, expected_token, expires_at = record
        if _is_probe_query(query):
            self._send_probe_response(transfer_id, expected_token)
            return
        token = _request_token(self.headers.get(TRANSFER_TOKEN_HEADER), query)
        if not hmac.compare_digest(token, expected_token) or time.time() > expires_at:
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
        transfer_id, query = _request_transfer_id_and_query(
            self.path,
            TRANSFER_UPLOAD_PATH_PREFIX,
        )
        record = _incoming_transfers.get(transfer_id)
        if record is None:
            self.send_error(404)
            return
        archive_path, expected_token, expires_at = record
        token = _request_token(self.headers.get(TRANSFER_TOKEN_HEADER), query)
        if not hmac.compare_digest(token, expected_token) or time.time() > expires_at:
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

    def _handle_probe(self, prefix: str, records: dict[str, tuple[Path, str, float]]):
        transfer_id, query = _request_transfer_id_and_query(self.path, prefix)
        if not _is_probe_query(query):
            self.send_error(405)
            return
        record = records.get(transfer_id)
        if record is None:
            self.send_error(404)
            return
        _archive_path, token, expires_at = record
        if time.time() > expires_at:
            self.send_error(403)
            return
        self._send_probe_response(transfer_id, token)

    def _send_probe_response(self, transfer_id: str, token: str) -> None:
        self.send_response(204)
        self.send_header(TRANSFER_PROOF_HEADER, _transfer_proof(transfer_id, token))
        self.end_headers()


def _request_transfer_id_and_query(
    path: str,
    prefix: str,
) -> tuple[str, dict[str, list[str]]]:
    transfer_id = path.split("?", maxsplit=1)[0].removeprefix(prefix)
    query: dict[str, list[str]] = {}
    if "?" in path:
        query = parse_qs(path.split("?", maxsplit=1)[1], keep_blank_values=True)
    return transfer_id, query


def _request_token(header_value: Optional[str], query: dict[str, list[str]]) -> str:
    if isinstance(header_value, str) and header_value.strip():
        return header_value.strip()
    token_values = query.get("token")
    if token_values:
        return str(token_values[0])
    return ""


def _is_probe_query(query: dict[str, list[str]]) -> bool:
    return query.get("probe", [""])[0] == "1"


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
    restore_runtime_fork_archive(
        archive_content=archive_path.read_bytes(),
        workspace_path=Path(workspace_path),
        home_path=Path.home(),
    )
    _cleanup_incoming_transfer(transfer_id)
    return True


def _direct_transfer_bind_host() -> str:
    configured = getattr(config, "RUNTIME_TRANSFER_BIND_HOST", None)
    if isinstance(configured, str) and configured.strip():
        return configured.strip()
    return DIRECT_TRANSFER_BIND_HOST


def _candidate_hosts(
    bind_host: str,
    *,
    direct_hosts: Optional[list[str]] = None,
) -> list[str]:
    hosts = []
    if isinstance(direct_hosts, list):
        hosts.extend(
            host.strip()
            for host in direct_hosts
            if isinstance(host, str) and host.strip()
        )
        return list(dict.fromkeys(hosts))

    if _is_loopback_host(bind_host):
        hosts.append(bind_host)
        return list(dict.fromkeys(hosts))

    configured = getattr(config, "RUNTIME_TRANSFER_HOST", None)
    if isinstance(configured, str) and configured.strip():
        hosts.append(configured.strip())
    if bind_host not in {"", "0.0.0.0", "::"}:
        hosts.append(bind_host)
    with contextlib.suppress(OSError):
        hostname = socket.gethostname()
        host = socket.gethostbyname(hostname)
        if host and not host.startswith("127."):
            hosts.append(host)
    hosts.append("127.0.0.1")
    return list(dict.fromkeys(hosts))


def _format_url_host(host: str) -> str:
    if ":" in host and not host.startswith("["):
        return f"[{host}]"
    return host


def _transfer_id_from_url(url: str) -> str:
    path = urlsplit(url).path
    for prefix in (TRANSFER_PATH_PREFIX, TRANSFER_UPLOAD_PATH_PREFIX):
        if path.startswith(prefix):
            return path.removeprefix(prefix)
    return ""


def _transfer_proof(transfer_id: str, token: str) -> str:
    return hashlib.sha256(f"{transfer_id}:{token}".encode("utf-8")).hexdigest()


def _is_loopback_host(host: str) -> bool:
    return host == "localhost" or host == "::1" or host.startswith("127.")


def _add_bytes_member(
    archive: tarfile.TarFile,
    name: str,
    data: bytes,
) -> None:
    member = tarfile.TarInfo(name)
    member.size = len(data)
    member.mtime = int(time.time())
    archive.addfile(member, io.BytesIO(data))


def _read_runtime_fork_metadata(archive: tarfile.TarFile) -> dict[str, Any]:
    raw_metadata = _read_archive_member_bytes(archive, RUNTIME_FORK_METADATA_MEMBER)
    try:
        metadata = json.loads(raw_metadata.decode("utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise ValueError("Runtime fork archive metadata is invalid") from exc
    if not isinstance(metadata, dict):
        raise ValueError("Runtime fork archive metadata must be an object")
    return metadata


def _read_archive_member_bytes(archive: tarfile.TarFile, name: str) -> bytes:
    try:
        member = archive.getmember(name)
    except KeyError as exc:
        raise ValueError(f"Runtime fork archive is missing {name}") from exc
    extracted = archive.extractfile(member)
    if extracted is None:
        raise ValueError(f"Runtime fork archive member is not readable: {name}")
    return extracted.read()


def _try_read_archive_member_bytes(
    archive: tarfile.TarFile, name: str
) -> Optional[bytes]:
    try:
        return _read_archive_member_bytes(archive, name)
    except ValueError:
        return None


def _export_codex_state(
    home: Path,
    thread_id: Optional[str],
) -> Optional[dict[str, Any]]:
    if not isinstance(thread_id, str) or not thread_id.strip():
        return None

    state_path = home / CODEX_STATE_RELATIVE_PATH
    if not state_path.is_file():
        return None

    uri = f"file:{state_path}?mode=ro"
    try:
        connection = sqlite3.connect(uri, uri=True, timeout=1.0)
        connection.row_factory = sqlite3.Row
        try:
            thread_row = connection.execute(
                "SELECT * FROM threads WHERE id = ?",
                (thread_id,),
            ).fetchone()
            if thread_row is None:
                return None
            dynamic_tool_rows = connection.execute(
                "SELECT * FROM thread_dynamic_tools WHERE thread_id = ? "
                "ORDER BY position",
                (thread_id,),
            ).fetchall()
        finally:
            connection.close()
    except sqlite3.Error as exc:
        logger.warning("Failed to export Codex thread state: %s", exc)
        return None

    thread = dict(thread_row)
    rollout_relative_path = _home_relative_path(home, thread.get("rollout_path"))
    return {
        "threadId": thread_id,
        "rolloutRelativePath": rollout_relative_path,
        "thread": thread,
        "threadDynamicTools": [dict(row) for row in dynamic_tool_rows],
    }


def _restore_codex_state(
    *,
    archive_content: bytes,
    workspace_path: Path,
    home_path: Path,
) -> None:
    with tarfile.open(fileobj=io.BytesIO(archive_content), mode="r:gz") as archive:
        raw_state = _try_read_archive_member_bytes(
            archive,
            RUNTIME_FORK_CODEX_STATE_MEMBER,
        )
    if not raw_state:
        return

    try:
        state = json.loads(raw_state.decode("utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise ValueError("Runtime fork Codex state metadata is invalid") from exc
    if not isinstance(state, dict):
        raise ValueError("Runtime fork Codex state metadata must be an object")

    thread = state.get("thread")
    if not isinstance(thread, dict):
        return
    thread_id = thread.get("id") or state.get("threadId")
    if not isinstance(thread_id, str) or not thread_id.strip():
        return

    target_state_path = home_path / CODEX_STATE_RELATIVE_PATH
    if not target_state_path.is_file():
        logger.warning(
            "Skipping Codex state restore because target state DB is missing: %s",
            target_state_path,
        )
        return

    thread = dict(thread)
    thread["id"] = thread_id
    thread["cwd"] = str(workspace_path.expanduser())
    rollout_relative_path = state.get("rolloutRelativePath")
    if isinstance(rollout_relative_path, str) and rollout_relative_path.strip():
        thread["rollout_path"] = str(home_path / rollout_relative_path)

    dynamic_tools = [
        dict(row)
        for row in state.get("threadDynamicTools", [])
        if isinstance(row, dict)
    ]
    try:
        connection = sqlite3.connect(str(target_state_path), timeout=5.0)
        try:
            _upsert_sqlite_row(connection, "threads", thread)
            connection.execute(
                "DELETE FROM thread_dynamic_tools WHERE thread_id = ?",
                (thread_id,),
            )
            for row in dynamic_tools:
                row["thread_id"] = thread_id
                _upsert_sqlite_row(connection, "thread_dynamic_tools", row)
            connection.commit()
        finally:
            connection.close()
    except sqlite3.Error as exc:
        raise ValueError(f"Failed to restore Codex thread state: {exc}") from exc


def _upsert_sqlite_row(
    connection: sqlite3.Connection,
    table_name: str,
    row: dict[str, Any],
) -> None:
    columns = _sqlite_table_columns(connection, table_name)
    payload = {key: value for key, value in row.items() if key in columns}
    if not payload:
        return
    column_names = list(payload.keys())
    placeholders = ", ".join("?" for _ in column_names)
    quoted_columns = ", ".join(f'"{column}"' for column in column_names)
    assignments = ", ".join(
        f'"{column}" = excluded."{column}"' for column in column_names
    )
    connection.execute(
        (
            f'INSERT INTO "{table_name}" ({quoted_columns}) '
            f"VALUES ({placeholders}) "
            f"ON CONFLICT DO UPDATE SET {assignments}"
        ),
        [payload[column] for column in column_names],
    )


def _sqlite_table_columns(
    connection: sqlite3.Connection,
    table_name: str,
) -> set[str]:
    rows = connection.execute(f'PRAGMA table_info("{table_name}")').fetchall()
    return {str(row[1]) for row in rows}


def _home_relative_path(home: Path, raw_path: Any) -> Optional[str]:
    if not isinstance(raw_path, str) or not raw_path.strip():
        return None
    try:
        path = Path(raw_path).expanduser().resolve()
        return path.relative_to(home.expanduser().resolve()).as_posix()
    except (OSError, ValueError):
        return None


def _ensure_git_commit_available(repository_root: Path, commit: str) -> None:
    if _git_commit_exists(repository_root, commit):
        return
    _run_git_required(repository_root, ["fetch", "--all", "--prune"])
    if not _git_commit_exists(repository_root, commit):
        raise ValueError(f"Base commit is not available on target: {commit}")


def _git_commit_exists(repository_root: Path, commit: str) -> bool:
    return (
        _run_git_text(repository_root, ["cat-file", "-e", f"{commit}^{{commit}}"])
        is not None
    )


def _extract_runtime_fork_untracked(
    archive: tarfile.TarFile,
    repository_root: Path,
) -> None:
    prefix = f"{RUNTIME_FORK_UNTRACKED_PREFIX}/"
    for member in archive.getmembers():
        if not member.name.startswith(prefix) or not member.isfile():
            continue
        relative_name = member.name[len(prefix) :].strip("/")
        if not relative_name or _is_unsafe_archive_member(relative_name):
            continue
        relative_path = Path(relative_name)
        if _has_excluded_part(relative_path.parts):
            continue
        extracted = archive.extractfile(member)
        if extracted is None:
            continue
        target_path = repository_root / relative_path
        target_path.parent.mkdir(parents=True, exist_ok=True)
        with target_path.open("wb") as destination:
            while chunk := extracted.read(ARCHIVE_IO_CHUNK_BYTES):
                destination.write(chunk)


def _is_unsafe_archive_member(name: str) -> bool:
    path = Path(name)
    return path.is_absolute() or ".." in path.parts


def _add_directory_children(
    archive: tarfile.TarFile,
    *,
    source: Path,
    prefix: str,
) -> None:
    for root, dir_names, file_names in os.walk(source):
        root_path = Path(root)
        dir_names[:] = [name for name in dir_names if not _should_exclude_name(name)]
        for file_name in file_names:
            if _should_exclude_name(file_name):
                continue
            path = root_path / file_name
            if not path.is_file() and not path.is_symlink():
                continue
            relative_path = path.relative_to(source).as_posix()
            archive.add(str(path), arcname=f"{prefix}/{relative_path}", recursive=False)


def _add_git_patch_members(
    archive: tarfile.TarFile,
    *,
    source: Path,
) -> None:
    repository_root = _git_repository_root(source)
    if repository_root is None:
        raise ValueError("Runtime fork requires a Git workspace")

    source_relative = _relative_git_path(repository_root, source)
    pathspec = [source_relative] if source_relative else ["."]
    base_commit, base_ref = _public_base_commit(repository_root)
    metadata = {
        "type": "git_patch",
        "baseCommit": base_commit,
        "baseRef": base_ref,
        "sourceHead": _git_stdout(repository_root, ["rev-parse", "HEAD"]),
        "sourceBranch": _git_stdout(repository_root, ["branch", "--show-current"]),
        "remoteUrl": _git_stdout(
            repository_root, ["config", "--get", "remote.origin.url"]
        ),
        "workspacePathspec": source_relative or ".",
    }
    patch_result = _run_git_bytes(
        repository_root,
        [
            "diff",
            "--binary",
            "--full-index",
            base_commit,
            "--",
            *pathspec,
        ],
    )
    if patch_result is None:
        raise ValueError("Failed to generate Git patch for runtime fork")

    _add_bytes_member(
        archive,
        RUNTIME_FORK_METADATA_MEMBER,
        json.dumps(metadata, ensure_ascii=False, sort_keys=True).encode("utf-8"),
    )
    _add_bytes_member(archive, RUNTIME_FORK_PATCH_MEMBER, patch_result.stdout)
    _add_git_untracked_members(
        archive,
        repository_root=repository_root,
        pathspec=pathspec,
    )


def _add_git_untracked_members(
    archive: tarfile.TarFile,
    *,
    repository_root: Path,
    pathspec: list[str],
) -> None:
    result = _run_git_bytes(
        repository_root,
        [
            "ls-files",
            "-z",
            "--others",
            "--exclude-standard",
            "--",
            *pathspec,
        ],
    )
    if result is None:
        raise ValueError("Failed to list untracked files for runtime fork")

    for raw_name in result.stdout.split(b"\0"):
        if not raw_name:
            continue
        repository_relative = Path(raw_name.decode("utf-8", "surrogateescape"))
        if _has_excluded_part(repository_relative.parts):
            continue
        path = repository_root / repository_relative
        if not path.exists() or not path.is_file():
            continue
        archive.add(
            str(path),
            arcname=f"{RUNTIME_FORK_UNTRACKED_PREFIX}/{repository_relative.as_posix()}",
            recursive=False,
        )


def _git_repository_root(path: Path) -> Optional[Path]:
    root = _git_stdout(path, ["rev-parse", "--show-toplevel"])
    if not root:
        return None
    return Path(root).expanduser().resolve()


def _public_base_commit(repository_root: Path) -> tuple[str, str]:
    candidates: list[str] = []
    upstream = _git_stdout(
        repository_root,
        ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
    )
    if upstream and upstream.startswith("origin/"):
        candidates.append(upstream)
    branch = _git_stdout(repository_root, ["branch", "--show-current"])
    if branch:
        candidates.append(f"origin/{branch}")
    origin_head = _git_stdout(
        repository_root,
        ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"],
    )
    if origin_head:
        candidates.append(origin_head)
    remote_refs = _git_stdout(
        repository_root,
        ["for-each-ref", "--format=%(refname:short)", "refs/remotes/origin"],
    )
    if remote_refs:
        candidates.extend(ref for ref in remote_refs.splitlines() if ref)

    for candidate in dict.fromkeys(candidates):
        base_commit = _git_stdout(
            repository_root,
            ["merge-base", "--fork-point", candidate, "HEAD"],
        ) or _git_stdout(repository_root, ["merge-base", "HEAD", candidate])
        if base_commit:
            return base_commit, candidate
    raise ValueError("Runtime fork requires a base commit available from origin")


def _git_stdout(cwd: Path, args: list[str]) -> Optional[str]:
    result = _run_git_text(cwd, args)
    if result is None:
        return None
    return result.stdout.strip()


def _run_git_text(
    cwd: Path,
    args: list[str],
) -> Optional[subprocess.CompletedProcess[str]]:
    try:
        return subprocess.run(
            ["git", *args],
            cwd=str(cwd),
            check=True,
            capture_output=True,
            text=True,
        )
    except (OSError, subprocess.CalledProcessError):
        return None


def _run_git_bytes(
    cwd: Path,
    args: list[str],
) -> Optional[subprocess.CompletedProcess[bytes]]:
    try:
        return subprocess.run(
            ["git", *args],
            cwd=str(cwd),
            check=True,
            capture_output=True,
        )
    except (OSError, subprocess.CalledProcessError):
        return None


def _run_git_required(cwd: Path, args: list[str]) -> None:
    try:
        subprocess.run(
            ["git", *args],
            cwd=str(cwd),
            check=True,
            capture_output=True,
            text=True,
        )
    except (OSError, subprocess.CalledProcessError) as exc:
        stderr = (
            exc.stderr if isinstance(exc, subprocess.CalledProcessError) else str(exc)
        )
        raise ValueError(f"Git command failed: {' '.join(args)}: {stderr}") from exc


def _run_git_required_bytes(
    cwd: Path,
    args: list[str],
    *,
    input_bytes: bytes,
) -> None:
    try:
        subprocess.run(
            ["git", *args],
            cwd=str(cwd),
            input=input_bytes,
            check=True,
            capture_output=True,
        )
    except (OSError, subprocess.CalledProcessError) as exc:
        stderr = (
            exc.stderr.decode("utf-8", "replace")
            if isinstance(exc, subprocess.CalledProcessError)
            else str(exc)
        )
        raise ValueError(f"Git command failed: {' '.join(args)}: {stderr}") from exc


def _relative_git_path(repository_root: Path, source: Path) -> str:
    try:
        relative_path = source.relative_to(repository_root)
    except ValueError:
        return "."
    relative_text = relative_path.as_posix()
    return "" if relative_text == "." else relative_text


def _add_home_session_members(
    archive: tarfile.TarFile,
    home: Path,
    *,
    session_paths: Optional[list[str]],
) -> None:
    explicit_paths = _home_relative_session_paths(home, session_paths or [])
    relative_names = explicit_paths
    for relative_name in relative_names:
        path = home / relative_name
        if not path.exists():
            continue
        if path.is_dir():
            _add_directory_children(
                archive,
                source=path,
                prefix=f"{HOME_ARCHIVE_PREFIX}/{relative_name}",
            )
        elif path.is_file() or path.is_symlink():
            archive.add(
                str(path),
                arcname=f"{HOME_ARCHIVE_PREFIX}/{relative_name}",
                recursive=False,
            )


def _home_relative_session_paths(home: Path, session_paths: list[str]) -> list[str]:
    relative_paths = []
    home = home.expanduser().resolve()
    for raw_path in session_paths:
        if not isinstance(raw_path, str) or not raw_path.strip():
            continue
        path = Path(raw_path).expanduser().resolve()
        try:
            relative_path = path.relative_to(home)
        except ValueError:
            continue
        if _has_excluded_part(relative_path.parts):
            continue
        relative_paths.append(relative_path.as_posix())
    return list(dict.fromkeys(relative_paths))


def _should_exclude_name(name: str) -> bool:
    return name in ARCHIVE_EXCLUDED_NAMES


def _has_excluded_part(parts: tuple[str, ...]) -> bool:
    return any(_should_exclude_name(part) for part in parts)
