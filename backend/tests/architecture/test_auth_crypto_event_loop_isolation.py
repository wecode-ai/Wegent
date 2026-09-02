# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Authentication crypto must never execute on Uvicorn's event loop."""

from __future__ import annotations

import ast
import asyncio
import io
import threading
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import UploadFile
from fastapi.responses import Response
from starlette.requests import Request

from app.api.endpoints import installed_plugins, oidc, wework_auth
from app.api.endpoints.adapter import attachments
from app.mcp_server import external_knowledge_app
from app.schemas.user import WeworkAuthSessionCreateRequest
from app.services.auth import oauth_provider as oauth_provider_module
from app.services.auth.oauth_provider import OAuthProviderService
from app.services.chat.access import auth as chat_auth
from app.services.oidc import OIDCService

APP_ROOT = Path(__file__).resolve().parents[2] / "app"
AUTH_ASYNC_FILES = (
    APP_ROOT / "api/endpoints/adapter/attachments.py",
    APP_ROOT / "api/endpoints/installed_plugins.py",
    APP_ROOT / "api/endpoints/oidc.py",
    APP_ROOT / "api/endpoints/wework_auth.py",
    APP_ROOT / "api/ws/device_namespace.py",
    APP_ROOT / "api/ws/terminal_namespace.py",
    APP_ROOT / "core/auth_utils.py",
    APP_ROOT / "core/security.py",
    APP_ROOT / "mcp_server/external_knowledge_app.py",
    APP_ROOT / "mcp_server/server.py",
    APP_ROOT / "services/auth/oauth_provider.py",
    APP_ROOT / "services/chat/access/auth.py",
    APP_ROOT / "services/oidc.py",
)
RISKY_SECURITY_CALLS = {
    "create_access_token",
    "decode",
    "encode",
    "get_password_hash",
    "get_unverified_claims",
    "get_unverified_header",
    "load_pem_private_key",
    "load_pem_public_key",
    "verify_document_download_token",
    "verify_password",
    "verify_task_token",
}
RISKY_SECURITY_HELPERS = {
    "_create_legacy_wework_access_token",
    "_create_wework_access_token",
    "_create_wework_refresh_token",
    "_decode_state",
    "_device_key_thumbprint",
    "_encode_state",
    "_extract_subtask_id_from_task_token",
    "_hash_secret",
    "_task_token_from_authorization",
    "_validated_device_public_key",
    "get_token_expiry",
}


class _AsyncSecurityVisitor(ast.NodeVisitor):
    def __init__(self) -> None:
        self.async_functions: list[str] = []
        self.violations: list[tuple[int, str, str]] = []

    def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef) -> None:
        self.async_functions.append(node.name)
        for statement in node.body:
            self.visit(statement)
        self.async_functions.pop()

    def visit_FunctionDef(self, node: ast.FunctionDef) -> None:
        if not self.async_functions:
            self.generic_visit(node)

    def visit_Lambda(self, node: ast.Lambda) -> None:
        if not self.async_functions:
            self.generic_visit(node)

    def visit_Call(self, node: ast.Call) -> None:
        if self.async_functions:
            name = _call_name(node.func)
            if name in RISKY_SECURITY_CALLS | RISKY_SECURITY_HELPERS:
                self.violations.append(
                    (node.lineno, self.async_functions[-1], ast.unparse(node.func))
                )
        self.generic_visit(node)


def _call_name(node: ast.expr) -> str:
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        return node.attr
    return ""


def _async_security_violations(source: str) -> list[tuple[int, str, str]]:
    visitor = _AsyncSecurityVisitor()
    visitor.visit(ast.parse(source))
    return visitor.violations


def test_auth_web_paths_do_not_call_crypto_directly_from_async_code() -> None:
    violations = []
    for path in AUTH_ASYNC_FILES:
        for line, function, call in _async_security_violations(path.read_text()):
            violations.append(
                f"{path.relative_to(APP_ROOT.parent)}:{line} {function}: {call}"
            )

    assert violations == []


def test_auth_crypto_static_gate_detects_direct_and_indirect_helpers() -> None:
    source = """
async def unsafe(token):
    jwt.decode(token, 'secret')
    _create_wework_access_token(token)

def safe(token):
    return jwt.decode(token, 'secret')
"""

    assert _async_security_violations(source) == [
        (3, "unsafe", "jwt.decode"),
        (4, "unsafe", "_create_wework_access_token"),
    ]


@pytest.mark.asyncio
async def test_oidc_id_token_crypto_runs_in_bounded_codec_worker(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service = OIDCService()
    loop_thread = threading.get_ident()
    worker_threads: list[int] = []

    monkeypatch.setattr(
        service,
        "get_metadata",
        AsyncMock(return_value={"issuer": "https://issuer.example"}),
    )
    monkeypatch.setattr(
        service,
        "get_jwks",
        AsyncMock(return_value={"keys": [{"kid": "key-1"}]}),
    )

    def parse_header(token: str) -> dict:
        worker_threads.append(threading.get_ident())
        return {"alg": "RS256", "kid": "key-1"}

    def decode_token(*args) -> dict:
        worker_threads.append(threading.get_ident())
        return {"sub": "user-1"}

    monkeypatch.setattr(service, "_parse_jwt_header", parse_header)
    monkeypatch.setattr(service, "_decode_id_token", decode_token)

    assert await service.verify_id_token("header.payload.signature", "nonce") == {
        "sub": "user-1"
    }
    assert len(worker_threads) == 2
    assert all(thread_id != loop_thread for thread_id in worker_threads)


@pytest.mark.asyncio
async def test_websocket_token_expiry_decode_runs_off_event_loop(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    loop_thread = threading.get_ident()
    worker_threads: list[int] = []

    def get_expiry(token: str) -> int:
        worker_threads.append(threading.get_ident())
        assert token == "jwt-token"
        return 123456

    monkeypatch.setattr(chat_auth, "get_token_expiry", get_expiry)

    assert await chat_auth.get_token_expiry_async("jwt-token") == 123456
    assert worker_threads == [worker_threads[0]]
    assert worker_threads[0] != loop_thread


@pytest.mark.asyncio
async def test_oauth_authorization_code_hash_runs_off_event_loop(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service = OAuthProviderService()
    loop_thread = threading.get_ident()
    worker_threads: list[int] = []

    def hash_secret(value: str) -> str:
        worker_threads.append(threading.get_ident())
        assert value == "attacker-controlled-code"
        return "code-hash"

    monkeypatch.setattr(service, "_hash_secret", hash_secret)
    monkeypatch.setattr(service, "_authenticate_client_id", lambda *_args: 7)
    monkeypatch.setattr(
        service,
        "_exchange_code_payload",
        lambda *_args: "token-response",
    )
    cache_pop = AsyncMock(return_value={"client_kind_id": 7})
    monkeypatch.setattr(oauth_provider_module.cache_manager, "pop", cache_pop)

    response = await service.exchange_code(
        client_id="client-id",
        client_secret=None,
        code="attacker-controlled-code",
        redirect_uri="https://client.example/callback",
        code_verifier="v" * 43,
    )

    assert response == "token-response"
    cache_pop.assert_awaited_once_with(f"oauth_authorization_code:code-hash")
    assert worker_threads == [worker_threads[0]]
    assert worker_threads[0] != loop_thread


@pytest.mark.asyncio
async def test_oidc_state_signing_and_verification_run_off_event_loop(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    loop_thread = threading.get_ident()
    worker_threads: list[int] = []

    def encode_state(payload: dict) -> str:
        worker_threads.append(threading.get_ident())
        return "signed-state"

    def decode_state(state: str) -> dict:
        worker_threads.append(threading.get_ident())
        return {"nonce": "nonce", "exp": int(oidc.time.time()) + 60}

    monkeypatch.setattr(oidc, "_encode_state", encode_state)
    monkeypatch.setattr(oidc, "_decode_state", decode_state)
    monkeypatch.setattr(
        oidc.oidc_service,
        "get_authorization_url",
        AsyncMock(return_value="https://issuer.example/authorize"),
    )

    response = await oidc.oidc_login(redirect=None, frontend_base_path=None)
    monkeypatch.setattr(
        oidc.oidc_service,
        "exchange_code_for_tokens",
        AsyncMock(return_value={"id_token": "id-token"}),
    )
    monkeypatch.setattr(
        oidc.oidc_service,
        "verify_id_token",
        AsyncMock(return_value={"sub": "subject", "email": "user@example.com"}),
    )
    monkeypatch.setattr(
        oidc,
        "run_sync_in_executor",
        AsyncMock(
            return_value=oidc._OIDCUserAuth(
                user_id=7,
                user_name="user",
                access_token="access-token",
            )
        ),
    )
    callback_response = await oidc.oidc_callback(
        code="code",
        state="signed-state",
        error=None,
    )

    assert response.status_code == 307
    assert callback_response.status_code == 302
    assert len(worker_threads) == 2
    assert all(thread_id != loop_thread for thread_id in worker_threads)


@pytest.mark.asyncio
async def test_oidc_token_exchange_decode_runs_off_event_loop(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service = OIDCService()
    loop_thread = threading.get_ident()
    worker_threads: list[int] = []

    class Client:
        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, traceback):
            return None

        async def send(self, request):
            return SimpleNamespace(content=b'{"access_token":"token"}')

    def parse_response(response) -> dict:
        worker_threads.append(threading.get_ident())
        return {"access_token": "token"}

    monkeypatch.setattr(
        service,
        "get_metadata",
        AsyncMock(return_value={"token_endpoint": "https://issuer.example/token"}),
    )
    monkeypatch.setattr(service, "_build_http_client", AsyncMock(return_value=Client()))
    monkeypatch.setattr(service, "_parse_token_response", parse_response)

    token = await service.exchange_code_for_tokens("code", "state")

    assert token == {"access_token": "token"}
    assert worker_threads == [worker_threads[0]]
    assert worker_threads[0] != loop_thread


@pytest.mark.asyncio
async def test_wework_device_key_and_token_signing_run_off_event_loop(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    loop_thread = threading.get_ident()
    worker_threads: list[int] = []
    public_key = {"kty": "EC", "crv": "P-256", "x": "x", "y": "y"}

    def device_identity(value: dict[str, str]):
        worker_threads.append(threading.get_ident())
        return value, "thumbprint"

    def issue_tokens(user, thumbprint):
        worker_threads.append(threading.get_ident())
        assert thumbprint == "thumbprint"
        return "access-token", "refresh-token"

    monkeypatch.setattr(wework_auth, "_validated_device_identity", device_identity)
    monkeypatch.setattr(wework_auth, "_issue_wework_session_tokens", issue_tokens)
    monkeypatch.setattr(
        wework_auth.cache_manager,
        "set",
        AsyncMock(return_value=True),
    )
    monkeypatch.setattr(
        wework_auth,
        "_read_session",
        AsyncMock(
            return_value={
                "status": "pending",
                "auth_mode": wework_auth.DEVICE_BOUND_REFRESH_AUTH_MODE,
                "device_thumbprint": "thumbprint",
            }
        ),
    )
    write_session = AsyncMock()
    monkeypatch.setattr(wework_auth, "_write_session", write_session)

    await wework_auth.create_wework_auth_session(
        WeworkAuthSessionCreateRequest(device_public_key=public_key)
    )
    await wework_auth.approve_wework_auth_session(
        "session-id",
        current_user=SimpleNamespace(id=7, user_name="alice"),
    )

    assert len(worker_threads) == 2
    assert all(thread_id != loop_thread for thread_id in worker_threads)
    assert write_session.await_args.args[1]["refresh_token"] == "refresh-token"


@pytest.mark.asyncio
async def test_task_token_parsers_run_off_event_loop(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    loop_thread = threading.get_ident()
    worker_threads: list[int] = []

    def parse_plugin_token(authorization: str):
        worker_threads.append(threading.get_ident())
        return None

    def parse_attachment_token(authorization: str) -> int:
        worker_threads.append(threading.get_ident())
        return 0

    monkeypatch.setattr(
        installed_plugins,
        "_task_token_from_authorization",
        parse_plugin_token,
    )
    monkeypatch.setattr(
        attachments,
        "_extract_subtask_id_from_task_token",
        parse_attachment_token,
    )
    monkeypatch.setattr(
        attachments,
        "_upload_attachment_sync",
        lambda *args, **kwargs: Response(b"{}", media_type="application/json"),
    )

    await installed_plugins._get_plugin_submission_auth(
        SimpleNamespace(headers={"Authorization": "Bearer token"}),
        current_user=SimpleNamespace(id=7, role="user"),
    )
    await attachments.upload_attachment(
        file=UploadFile(file=io.BytesIO(b"data"), filename="data.txt"),
        overwrite_attachment_id=None,
        storage_purpose="default",
        current_user=SimpleNamespace(id=7),
        authorization="Bearer token",
    )

    assert len(worker_threads) == 2
    assert all(thread_id != loop_thread for thread_id in worker_threads)


@pytest.mark.asyncio
async def test_external_document_token_verification_runs_off_event_loop(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.services.knowledge import external_document_access

    loop_thread = threading.get_ident()
    worker_threads: list[int] = []

    def verify_token(token: str):
        worker_threads.append(threading.get_ident())
        return None

    monkeypatch.setattr(
        external_document_access,
        "verify_document_download_token",
        verify_token,
    )
    monkeypatch.setattr(
        external_knowledge_app.settings,
        "EXTERNAL_KNOWLEDGE_MCP_DOWNLOAD_RATE_LIMIT_ENABLED",
        False,
    )
    request = Request(
        {
            "type": "http",
            "http_version": "1.1",
            "method": "GET",
            "scheme": "http",
            "path": "/documents/41/file",
            "raw_path": b"/documents/41/file",
            "query_string": b"",
            "headers": [(b"x-wegent-download-token", b"token")],
            "path_params": {"document_id": 41},
            "client": ("127.0.0.1", 12345),
            "server": ("testserver", 80),
        }
    )

    response = await external_knowledge_app._document_file(request)

    assert response.status_code == 401
    assert worker_threads == [worker_threads[0]]
    assert worker_threads[0] != loop_thread
