# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Interactive local device session handler and HTTP/WebSocket gateway."""

import asyncio
import contextlib
import os
import signal
import socket
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal, Optional
from urllib.parse import parse_qsl, urlencode

from aiohttp import ClientSession, CookieJar, WSMsgType, web

from executor.config import config
from executor.platform_compat import sanitize_ld_library_path
from shared.logger import setup_logger

logger = setup_logger("local_session_handler")

DEFAULT_GATEWAY_HOST = "0.0.0.0"
DEFAULT_GATEWAY_PORT = 17888
DEFAULT_PUBLIC_BASE_URL = "http://localhost:17888"
DEFAULT_SESSION_TTL_SECONDS = 60 * 60
SESSION_IDLE_GRACE_SECONDS = 3
SESSION_PORT_READY_TIMEOUT_SECONDS = 5.0
SESSION_PORT_CONNECT_TIMEOUT_SECONDS = 0.2
SESSION_PORT_RETRY_INTERVAL_SECONDS = 0.05

SessionType = Literal["terminal", "code_server"]


@dataclass
class LocalSession:
    """State for a running interactive session process."""

    session_id: str
    session_type: SessionType
    access_token: str
    project_id: int
    path: str
    port: int
    process: Optional[asyncio.subprocess.Process]
    expires_at: float
    active_websockets: int = 0
    connected_once: bool = False
    cleanup_task: Optional[asyncio.Task] = None
    code_server_authenticated: bool = False
    created_at: float = field(default_factory=time.time)


class SessionGateway:
    """HTTP/WebSocket reverse proxy for device sessions."""

    def __init__(
        self,
        sessions: dict[str, LocalSession],
        host: str = DEFAULT_GATEWAY_HOST,
        port: int = DEFAULT_GATEWAY_PORT,
    ):
        self.sessions = sessions
        self.host = host
        self.port = port
        self._runner: Optional[web.AppRunner] = None
        self._client_session: Optional[ClientSession] = None

    async def start(self) -> None:
        """Start the gateway if it is not already running."""
        if self._runner:
            return

        app = web.Application()
        app.router.add_route("*", "/{tail:.*}", self._handle_request)
        self._client_session = ClientSession(cookie_jar=CookieJar(unsafe=True))
        self._runner = web.AppRunner(app)
        await self._runner.setup()
        site = web.TCPSite(self._runner, self.host, self.port)
        await site.start()
        logger.info("[SessionGateway] Listening on %s:%s", self.host, self.port)

    async def stop(self) -> None:
        """Stop the gateway and close proxy client resources."""
        if self._runner:
            await self._runner.cleanup()
            self._runner = None
        if self._client_session:
            await self._client_session.close()
            self._client_session = None

    async def _handle_request(self, request: web.Request) -> web.StreamResponse:
        session = self._resolve_session(request)
        if not session:
            return web.Response(status=404, text="Session not found")
        if not self._is_authorized(request, session):
            return web.Response(status=401, text="Invalid session token")
        if time.time() > session.expires_at:
            return web.Response(status=410, text="Session expired")

        # On first authenticated request, set auth cookies and redirect to
        # the clean URL so the token does not remain visible in the address bar.
        if self._should_redirect_authenticated_request(request, session):
            query_items = [
                (k, v)
                for k, v in parse_qsl(request.query_string, keep_blank_values=True)
                if k != "token"
            ]
            clean_query = urlencode(query_items)
            clean_url = f"{request.path}?{clean_query}" if clean_query else request.path
            response = web.Response(status=302)
            response.headers["Location"] = clean_url
            self._set_session_cookies(response, session, request)
            return response

        if request.headers.get("Upgrade", "").lower() == "websocket":
            return await self._proxy_websocket(request, session)
        return await self._proxy_http(request, session)

    def _resolve_session(self, request: web.Request) -> Optional[LocalSession]:
        path_parts = [part for part in request.path.split("/") if part]
        if len(path_parts) >= 2 and path_parts[0] == "s":
            return self.sessions.get(path_parts[1])

        session_id = request.query.get("session_id") or request.cookies.get(
            "wegent_active_session"
        )
        if not session_id:
            return None
        return self.sessions.get(session_id)

    def _should_redirect_authenticated_request(
        self,
        request: web.Request,
        session: LocalSession,
    ) -> bool:
        return (
            session.session_type == "code_server"
            and request.query.get("token")
            and request.query.get("embed") != "1"
            and request.headers.get("Upgrade", "").lower() != "websocket"
        )

    def _is_authorized(self, request: web.Request, session: LocalSession) -> bool:
        terminal_prefix = f"/s/{session.session_id}"
        if session.session_type == "terminal" and (
            request.path == terminal_prefix
            or request.path.startswith(f"{terminal_prefix}/")
        ):
            return True

        token = request.query.get("token") or request.cookies.get(
            self._token_cookie_name(session.session_id)
        )
        return token == session.access_token

    async def _proxy_http(
        self,
        request: web.Request,
        session: LocalSession,
    ) -> web.Response:
        client = self._require_client_session()
        if session.session_type == "code_server":
            await self._ensure_code_server_login(session)
        upstream_url = self._build_upstream_url(request, session, "http")
        headers = self._proxy_headers(request, session)
        body = await request.read()

        async with client.request(
            request.method,
            upstream_url,
            headers=headers,
            data=body,
            allow_redirects=False,
        ) as upstream:
            response = web.Response(
                status=upstream.status,
                headers=self._response_headers(upstream.headers),
                body=await upstream.read(),
            )
            self._set_session_cookies(response, session, request)
            return response

    async def _proxy_websocket(
        self,
        request: web.Request,
        session: LocalSession,
    ) -> web.WebSocketResponse:
        client = self._require_client_session()
        if session.session_type == "code_server":
            await self._ensure_code_server_login(session)
        protocols = self._websocket_protocols(request)
        ws_response = web.WebSocketResponse(protocols=protocols)
        await ws_response.prepare(request)
        upstream_url = self._build_upstream_url(request, session, "ws")
        headers = self._proxy_headers(request, session)

        session.active_websockets += 1
        session.connected_once = True
        self._cancel_cleanup(session)

        try:
            async with client.ws_connect(
                upstream_url,
                headers=headers,
                protocols=protocols,
            ) as upstream_ws:
                await self._proxy_websocket_pair(ws_response, upstream_ws)
        except Exception:
            if not ws_response.closed:
                await ws_response.close(code=1011)
        finally:
            session.active_websockets = max(session.active_websockets - 1, 0)
            if (
                session.active_websockets == 0
                and session.connected_once
                and session.session_type == "terminal"
            ):
                self._schedule_cleanup(session)

        return ws_response

    async def _proxy_websocket_pair(self, client_ws: Any, upstream_ws: Any) -> None:
        tasks = [
            asyncio.create_task(self._pipe_websocket(client_ws, upstream_ws)),
            asyncio.create_task(self._pipe_websocket(upstream_ws, client_ws)),
        ]
        done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        for task in pending:
            task.cancel()
        await asyncio.gather(*pending, return_exceptions=True)
        await asyncio.gather(*done, return_exceptions=True)

    async def _pipe_websocket(self, source: Any, target: Any) -> None:
        async for message in source:
            if message.type == WSMsgType.TEXT:
                await target.send_str(message.data)
            elif message.type == WSMsgType.BINARY:
                await target.send_bytes(message.data)
            elif message.type in (WSMsgType.CLOSE, WSMsgType.CLOSING, WSMsgType.CLOSED):
                await target.close()
                break
            elif message.type == WSMsgType.ERROR:
                await target.close()
                break

    def _websocket_protocols(self, request: web.Request) -> list[str]:
        header = request.headers.get("Sec-WebSocket-Protocol", "")
        return [protocol.strip() for protocol in header.split(",") if protocol.strip()]

    def _build_upstream_url(
        self,
        request: web.Request,
        session: LocalSession,
        scheme: Literal["http", "ws"],
    ) -> str:
        path = self._upstream_path(request, session)
        query_items = [
            (key, value)
            for key, value in parse_qsl(request.query_string, keep_blank_values=True)
            if key not in {"token", "session_id"}
        ]
        query = urlencode(query_items)
        suffix = f"{path}?{query}" if query else path
        return f"{scheme}://127.0.0.1:{session.port}{suffix}"

    def _upstream_path(self, request: web.Request, session: LocalSession) -> str:
        path = request.path
        if session.session_type != "code_server":
            return path

        prefix = f"/s/{session.session_id}"
        if path == prefix:
            return "/"
        if path.startswith(f"{prefix}/"):
            return path[len(prefix) :] or "/"
        return path

    def _proxy_headers(
        self,
        request: web.Request,
        session: Optional[LocalSession] = None,
    ) -> dict[str, str]:
        excluded = {
            "connection",
            "host",
            "keep-alive",
            "proxy-authenticate",
            "proxy-authorization",
            "accept-encoding",
            "te",
            "trailers",
            "transfer-encoding",
            "upgrade",
            "sec-websocket-protocol",
            "sec-websocket-key",
            "sec-websocket-version",
            "sec-websocket-extensions",
        }
        headers = {
            key: value
            for key, value in request.headers.items()
            if key.lower() not in excluded
        }
        headers["Accept-Encoding"] = "identity"
        if session and session.session_type == "code_server" and "Origin" in headers:
            headers["Origin"] = f"http://127.0.0.1:{session.port}"
        return headers

    def _response_headers(self, headers: Any) -> dict[str, str]:
        excluded = {
            "connection",
            "content-encoding",
            "content-length",
            "keep-alive",
            "proxy-authenticate",
            "proxy-authorization",
            "set-cookie",
            "te",
            "trailers",
            "transfer-encoding",
            "upgrade",
        }
        return {
            key: value for key, value in headers.items() if key.lower() not in excluded
        }

    async def _ensure_code_server_login(self, session: LocalSession) -> None:
        if session.code_server_authenticated:
            return

        client = self._require_client_session()
        password = self._code_server_password()
        login_url = f"http://127.0.0.1:{session.port}/login"

        async with client.post(
            login_url,
            data={"password": password},
            headers={"Accept-Encoding": "identity"},
            allow_redirects=False,
        ) as response:
            await response.read()
            if response.status not in {302, 303}:
                raise web.HTTPBadGateway(text="Failed to authenticate code-server")
        session.code_server_authenticated = True

    def _code_server_password(self) -> str:
        return os.getenv("CODE_SERVER_PASSWORD") or os.getenv("PASSWORD") or "wegent"

    def _set_session_cookies(
        self,
        response: web.Response,
        session: LocalSession,
        request: web.Request,
    ) -> None:
        if request.query.get("token") != session.access_token:
            return
        max_age = max(int(session.expires_at - time.time()), 1)
        response.set_cookie(
            self._token_cookie_name(session.session_id),
            session.access_token,
            max_age=max_age,
            httponly=True,
            samesite="Lax",
            path="/",
        )
        if session.session_type == "code_server":
            response.set_cookie(
                "wegent_active_session",
                session.session_id,
                max_age=max_age,
                httponly=True,
                samesite="Lax",
                path="/",
            )

    def _schedule_cleanup(self, session: LocalSession) -> None:
        self._cancel_cleanup(session)
        session.cleanup_task = asyncio.create_task(self._cleanup_after_idle(session))

    def _cancel_cleanup(self, session: LocalSession) -> None:
        if session.cleanup_task and not session.cleanup_task.done():
            session.cleanup_task.cancel()
        session.cleanup_task = None

    async def _cleanup_after_idle(self, session: LocalSession) -> None:
        await asyncio.sleep(SESSION_IDLE_GRACE_SECONDS)
        if session.active_websockets == 0:
            await terminate_session_process(session.process)

    def _require_client_session(self) -> ClientSession:
        if not self._client_session:
            raise RuntimeError("Session gateway is not running")
        return self._client_session

    def _token_cookie_name(self, session_id: str) -> str:
        return f"wegent_session_{session_id}"


class LocalSessionHandler:
    """Start and manage ttyd/code-server sessions for local device projects."""

    def __init__(
        self,
        *,
        public_base_url: Optional[str] = None,
        gateway_host: Optional[str] = None,
        gateway_port: Optional[int] = None,
    ):
        self.public_base_url = (
            public_base_url
            or os.getenv("DEVICE_PUBLIC_BASE_URL")
            or DEFAULT_PUBLIC_BASE_URL
        ).rstrip("/")
        self.gateway_host = gateway_host or os.getenv(
            "DEVICE_SESSION_GATEWAY_HOST",
            DEFAULT_GATEWAY_HOST,
        )
        self.gateway_port = gateway_port or int(
            os.getenv("DEVICE_SESSION_GATEWAY_PORT", str(DEFAULT_GATEWAY_PORT))
        )
        self.code_server_port = int(os.getenv("DEVICE_CODE_SERVER_PORT", "18080"))
        self.sessions: dict[str, LocalSession] = {}
        self.gateway = SessionGateway(
            self.sessions,
            host=self.gateway_host,
            port=self.gateway_port,
        )

    async def start_gateway(self) -> None:
        """Start the shared session gateway."""
        await self.gateway.start()

    async def stop(self) -> None:
        """Stop all sessions and the gateway."""
        await self.gateway.stop()
        sessions = list(self.sessions.values())
        self.sessions.clear()
        await asyncio.gather(
            *(
                terminate_session_process(session.process)
                for session in sessions
                if session.process is not None
            ),
            return_exceptions=True,
        )

    async def handle_start_session(self, data: dict[str, Any]) -> dict[str, Any]:
        """Handle Backend RPC requests to start an interactive session."""
        try:
            session_type = self._get_session_type(data)
            session_id = self._get_required_string(data, "session_id")
            access_token = self._get_required_string(data, "access_token")
            project_id = int(data.get("project_id"))
            path = self._get_project_path(data)
            ttl_seconds = self._get_ttl_seconds(data)
        except (TypeError, ValueError) as exc:
            return self._error(str(exc))

        if session_id in self.sessions:
            existing = self.sessions.pop(session_id)
            if existing.process is not None:
                await terminate_session_process(existing.process)

        if session_type == "code_server":
            session = LocalSession(
                session_id=session_id,
                session_type=session_type,
                access_token=access_token,
                project_id=project_id,
                path=path,
                port=self.code_server_port,
                process=None,
                expires_at=time.time() + ttl_seconds,
            )
            self.sessions[session_id] = session
            url = self._build_session_url(session_type, session_id, access_token, path)
            logger.info(
                "[LocalSessionHandler] code_server gateway URL for project %s: %s",
                project_id,
                url,
            )
            return {
                "success": True,
                "session_id": session_id,
                "project_id": project_id,
                "type": session_type,
                "path": path,
                "url": url,
            }

        port = _find_free_port()
        argv = self._build_session_argv(
            session_type, path, port, session_id, project_id
        )
        logger.info(
            "[LocalSessionHandler] Starting %s session %s for project %s at %s",
            session_type,
            session_id,
            project_id,
            path,
        )

        try:
            process = await asyncio.create_subprocess_exec(
                *argv,
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.DEVNULL,
                cwd=path,
                env=self._build_env(),
                start_new_session=os.name != "nt",
            )
        except Exception as exc:
            logger.exception("[LocalSessionHandler] Failed to start session")
            return self._error(str(exc))

        is_ready = await _wait_for_session_port("127.0.0.1", port, process)
        if not is_ready:
            await terminate_session_process(process)
            return self._error("Terminal session failed to become ready")

        session = LocalSession(
            session_id=session_id,
            session_type=session_type,
            access_token=access_token,
            project_id=project_id,
            path=path,
            port=port,
            process=process,
            expires_at=time.time() + ttl_seconds,
        )
        self.sessions[session_id] = session
        asyncio.create_task(self._watch_session(session))

        return {
            "success": True,
            "session_id": session_id,
            "project_id": project_id,
            "type": session_type,
            "path": path,
            "url": self._build_session_url(
                session_type, session_id, access_token, path
            ),
        }

    def _build_session_argv(
        self,
        session_type: SessionType,
        path: str,
        port: int,
        session_id: str,
        project_id: int = 0,
    ) -> list[str]:
        return [
            "ttyd",
            "-i",
            "127.0.0.1",
            "-p",
            str(port),
            "-w",
            path,
            "-m",
            "1",
            "-o",
            "-W",
            "-b",
            f"/s/{session_id}",
            "bash",
        ]

    def _build_session_url(
        self,
        session_type: SessionType,
        session_id: str,
        access_token: str,
        path: str = "",
    ) -> str:
        query_items = [("token", access_token)]
        if session_type == "code_server" and path:
            query_items.append(("folder", path))
        query = urlencode(query_items)
        return f"{self.public_base_url}/s/{session_id}/?{query}"

    async def _watch_session(self, session: LocalSession) -> None:
        try:
            await session.process.wait()
        except Exception:
            logger.exception("[LocalSessionHandler] Session watcher failed")
        finally:
            self.sessions.pop(session.session_id, None)

    def _get_session_type(self, data: dict[str, Any]) -> SessionType:
        session_type = data.get("type")
        if session_type not in {"terminal", "code_server"}:
            raise ValueError("type must be terminal or code_server")
        return session_type

    def _get_required_string(self, data: dict[str, Any], key: str) -> str:
        value = data.get(key)
        if not isinstance(value, str) or not value.strip():
            raise ValueError(f"{key} is required")
        return value.strip()

    def _get_project_path(self, data: dict[str, Any]) -> str:
        path = self._get_required_string(data, "path")
        project_path = Path(path).expanduser()
        if not project_path.is_absolute():
            project_path = Path(config.get_workspace_root()).expanduser() / project_path
        if data.get("create_if_missing") is True:
            project_path.mkdir(parents=True, exist_ok=True)
        if not project_path.exists():
            raise ValueError(f"Project path does not exist: {path}")
        if not project_path.is_dir():
            raise ValueError(f"Project path is not a directory: {path}")
        return str(project_path)

    def _get_ttl_seconds(self, data: dict[str, Any]) -> int:
        try:
            ttl_seconds = int(data.get("ttl_seconds", DEFAULT_SESSION_TTL_SECONDS))
        except (TypeError, ValueError):
            return DEFAULT_SESSION_TTL_SECONDS
        if ttl_seconds <= 0:
            return DEFAULT_SESSION_TTL_SECONDS
        return min(ttl_seconds, DEFAULT_SESSION_TTL_SECONDS)

    def _build_env(self) -> dict[str, str]:
        env = os.environ.copy()
        sanitize_ld_library_path(env)
        return env

    def _error(self, error: str) -> dict[str, Any]:
        return {"success": False, "error": error}


def _find_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


async def _wait_for_session_port(
    host: str,
    port: int,
    process: asyncio.subprocess.Process,
    timeout: float = SESSION_PORT_READY_TIMEOUT_SECONDS,
) -> bool:
    """Wait until the session process accepts TCP connections."""
    deadline = time.monotonic() + timeout
    loop = asyncio.get_running_loop()

    while time.monotonic() < deadline:
        if getattr(process, "returncode", None) is not None:
            return False

        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.setblocking(False)
        try:
            await asyncio.wait_for(
                loop.sock_connect(sock, (host, port)),
                timeout=SESSION_PORT_CONNECT_TIMEOUT_SECONDS,
            )
            return True
        except (OSError, asyncio.TimeoutError):
            await asyncio.sleep(SESSION_PORT_RETRY_INTERVAL_SECONDS)
        finally:
            sock.close()

    return False


async def terminate_session_process(process: asyncio.subprocess.Process) -> None:
    """Terminate a session process and its process group."""
    if process.returncode is not None:
        return

    try:
        if os.name != "nt":
            os.killpg(process.pid, signal.SIGTERM)
        else:
            process.terminate()
        await asyncio.wait_for(process.wait(), timeout=2)
    except Exception:
        with contextlib.suppress(Exception):
            if os.name != "nt":
                os.killpg(process.pid, signal.SIGKILL)
            else:
                process.kill()
        with contextlib.suppress(Exception):
            await process.wait()
