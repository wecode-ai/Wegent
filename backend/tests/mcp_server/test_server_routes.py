# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for MCP server routing and URL configuration."""

from datetime import datetime
from pathlib import Path
from unittest.mock import ANY, AsyncMock, MagicMock, patch

import pytest
from fastapi.testclient import TestClient
from starlette.applications import Starlette
from starlette.responses import JSONResponse, PlainTextResponse
from starlette.routing import Route

from app.core.config import settings
from app.core.rate_limit import ExternalMcpRateLimitStatus
from app.main import _get_mcp_lifespan_servers, create_app
from app.mcp_server import server as mcp_server_module
from app.mcp_server.server import (
    ExternalKnowledgeUser,
    _build_external_knowledge_mcp_app,
    _create_knowledge_mcp_app,
    _default_external_auth_handler,
    external_knowledge_mcp_server,
    get_mcp_knowledge_config,
    knowledge_mcp_server,
    set_external_knowledge_auth_handler,
)
from app.models.knowledge import DocumentIndexStatus, KnowledgeDocument
from app.models.subtask_context import ContextType, SubtaskContext
from app.services.context.context_service import context_service
from app.services.knowledge.external_document_access import (
    DOWNLOAD_TOKEN_HEADER,
    create_document_download_token,
)


class NonClosingSession:
    def __init__(self, db):
        self._db = db

    def __getattr__(self, name):
        return getattr(self._db, name)

    def close(self):
        pass


@pytest.fixture(autouse=True)
def allow_external_transport_rate_limit():
    with (
        patch(
            "app.mcp_server.external_knowledge_app.check_external_mcp_rate_limit",
            return_value=ExternalMcpRateLimitStatus.ALLOWED,
        ),
        patch(
            "app.mcp_server.external_knowledge_app.check_external_mcp_dimension_rate_limit",
            return_value=ExternalMcpRateLimitStatus.ALLOWED,
        ),
    ):
        yield


def _create_external_document_with_attachment(
    test_db,
    test_user,
    *,
    knowledge_base_id: int = 31,
    file_name: str = "report.pdf",
    mime_type: str = "application/pdf",
    file_extension: str = ".pdf",
    storage_key: str = "attachments/report.pdf",
):
    attachment = SubtaskContext(
        subtask_id=0,
        user_id=test_user.id,
        context_type=ContextType.ATTACHMENT.value,
        name=file_name,
        status="ready",
        binary_data=b"",
        image_base64="",
        extracted_text="report",
        text_length=6,
        type_data={
            "original_filename": file_name,
            "file_extension": file_extension,
            "file_size": 11,
            "mime_type": mime_type,
            "storage_backend": "mysql",
            "storage_key": storage_key,
        },
    )
    test_db.add(attachment)
    test_db.flush()
    document = KnowledgeDocument(
        kind_id=knowledge_base_id,
        attachment_id=attachment.id,
        name=file_name,
        file_extension=file_extension.lstrip("."),
        file_size=11,
        user_id=test_user.id,
        is_active=True,
        index_status=DocumentIndexStatus.SUCCESS,
        source_type="file",
        folder_id=0,
    )
    test_db.add(document)
    test_db.commit()
    return document


def test_knowledge_mcp_root_returns_metadata_json():
    app = _create_knowledge_mcp_app()
    client = TestClient(app)

    response = client.get("/")

    assert response.status_code == 200
    assert response.json() == {
        "service": "wegent-knowledge-mcp",
        "transport": "streamable-http",
        "endpoints": {
            "mcp": "/mcp/knowledge/sse",
            "health": "/mcp/knowledge/health",
        },
    }


def test_external_knowledge_mcp_root_returns_metadata_json():
    app = _build_external_knowledge_mcp_app()
    client = TestClient(app)

    response = client.get("/")

    assert response.status_code == 200
    assert response.json() == {
        "service": "wegent-knowledge-external-mcp",
        "transport": "streamable-http",
        "endpoints": {
            "mcp": "/mcp/knowledge-external/sse",
            "health": "/mcp/knowledge-external/health",
            "document_file": "/mcp/knowledge-external/documents/{document_id}/file",
        },
        "tools": [
            "wegent_kb_list_knowledge_bases",
            "wegent_kb_list_nodes",
            "wegent_kb_get_document_content",
            "wegent_kb_get_document_download",
            "wegent_kb_search_content",
        ],
    }


def test_external_knowledge_mcp_docs_cover_metadata_tools_and_file_endpoint():
    app = _build_external_knowledge_mcp_app()
    client = TestClient(app)
    metadata = client.get("/").json()
    repo_root = Path(__file__).resolve().parents[3]
    docs = [
        (repo_root / "docs/zh/developer-guide/external-knowledge-mcp.md").read_text(),
        (repo_root / "docs/en/developer-guide/external-knowledge-mcp.md").read_text(),
    ]

    for doc in docs:
        for tool_name in metadata["tools"]:
            assert tool_name in doc
        assert "documents/{document_id}/file" in doc
        assert "X-Wegent-Download-Token" in doc


def test_get_mcp_knowledge_config_uses_sse_endpoint():
    config = get_mcp_knowledge_config(
        backend_url="http://localhost:8000",
        auth_token="test-token",
    )

    assert (
        config["wegent-knowledge"]["url"] == "http://localhost:8000/mcp/knowledge/sse"
    )


def test_knowledge_mcp_sse_without_trailing_slash_does_not_redirect():
    fake_streamable_app = Starlette(
        routes=[Route("/", lambda request: PlainTextResponse("ok"), methods=["GET"])]
    )

    with patch.object(
        knowledge_mcp_server,
        "streamable_http_app",
        return_value=fake_streamable_app,
    ):
        app = _create_knowledge_mcp_app()

    client = TestClient(app)
    response = client.get("/sse", follow_redirects=False)

    assert response.status_code == 200
    assert response.text == "ok"


def test_external_knowledge_mcp_sse_without_trailing_slash_does_not_redirect():
    fake_streamable_app = Starlette(
        routes=[Route("/", lambda request: PlainTextResponse("ok"), methods=["GET"])]
    )

    with (
        patch.object(
            external_knowledge_mcp_server,
            "streamable_http_app",
            return_value=fake_streamable_app,
        ),
        patch(
            "app.mcp_server.server._external_auth_handler",
            return_value=ExternalKnowledgeUser(id=7, user_name="alice"),
        ),
    ):
        app = _build_external_knowledge_mcp_app()
        client = TestClient(app)
        response = client.get("/sse", follow_redirects=False)

    assert response.status_code == 200
    assert response.text == "ok"


def test_default_external_knowledge_auth_uses_api_key_owner(
    test_api_key,
    test_db,
    test_user,
):
    raw_key, api_key_record = test_api_key
    original_last_used = datetime(2026, 1, 1, 8, 0, 0)
    api_key_record.last_used_at = original_last_used
    test_db.commit()
    request = mcp_server_module.Request(
        {
            "type": "http",
            "headers": [(b"x-user-name", b"mallory")],
        }
    )

    with patch("app.db.session.SessionLocal", return_value=NonClosingSession(test_db)):
        user = _default_external_auth_handler(raw_key, request)

    test_db.refresh(api_key_record)
    assert user == ExternalKnowledgeUser(id=test_user.id, user_name=test_user.user_name)
    assert api_key_record.last_used_at == original_last_used


def test_external_knowledge_mcp_auth_ignores_x_api_key(
    test_api_key,
    test_db,
    test_user,
):
    async def context_response(request):
        user = mcp_server_module._external_knowledge_request_user.get()
        return JSONResponse(
            {
                "user_id": user.id if user else None,
                "user_name": user.user_name if user else None,
            }
        )

    raw_key, _ = test_api_key
    fake_streamable_app = Starlette(
        routes=[Route("/", context_response, methods=["GET"])]
    )

    with patch.object(
        external_knowledge_mcp_server,
        "streamable_http_app",
        return_value=fake_streamable_app,
    ):
        app = _build_external_knowledge_mcp_app()
        client = TestClient(app)
        response = client.get(
            "/sse",
            headers={
                "X-API-Key": raw_key,
                "X-User-Name": "mallory",
            },
        )

    assert response.status_code == 401
    assert response.json() == {
        "error": "Authentication required",
        "code": "unauthorized",
    }


def test_external_knowledge_mcp_rejects_missing_authentication():
    fake_streamable_app = Starlette(
        routes=[Route("/", lambda request: PlainTextResponse("ok"), methods=["GET"])]
    )

    with patch.object(
        external_knowledge_mcp_server,
        "streamable_http_app",
        return_value=fake_streamable_app,
    ):
        app = _build_external_knowledge_mcp_app()
        client = TestClient(app)
        response = client.get("/sse")

    assert response.status_code == 401
    assert response.json() == {
        "error": "Authentication required",
        "code": "unauthorized",
    }


def test_external_knowledge_mcp_auth_accepts_bearer_api_key(
    test_api_key,
    test_db,
    test_user,
):
    async def context_response(request):
        user = mcp_server_module._external_knowledge_request_user.get()
        return JSONResponse(
            {
                "user_id": user.id if user else None,
                "user_name": user.user_name if user else None,
            }
        )

    raw_key, _ = test_api_key
    fake_streamable_app = Starlette(
        routes=[Route("/", context_response, methods=["GET"])]
    )

    with (
        patch.object(
            external_knowledge_mcp_server,
            "streamable_http_app",
            return_value=fake_streamable_app,
        ),
        patch("app.db.session.SessionLocal", return_value=NonClosingSession(test_db)),
    ):
        app = _build_external_knowledge_mcp_app()
        client = TestClient(app)
        response = client.get(
            "/sse",
            headers={
                "Authorization": f"Bearer {raw_key}",
                "X-User-Name": "mallory",
            },
        )

    assert response.status_code == 200
    assert response.json() == {
        "user_id": test_user.id,
        "user_name": test_user.user_name,
    }


def test_external_knowledge_mcp_custom_auth_sets_lightweight_user_context():
    async def context_response(request):
        user = mcp_server_module._external_knowledge_request_user.get()
        return JSONResponse(
            {
                "user_id": user.id if user else None,
                "user_name": user.user_name if user else None,
            }
        )

    fake_streamable_app = Starlette(
        routes=[Route("/", context_response, methods=["GET"])]
    )

    with (
        patch.object(
            external_knowledge_mcp_server,
            "streamable_http_app",
            return_value=fake_streamable_app,
        ),
        patch(
            "app.mcp_server.server._external_auth_handler",
            return_value=ExternalKnowledgeUser(id=7, user_name="alice"),
        ) as auth_handler,
    ):
        app = _build_external_knowledge_mcp_app()
        client = TestClient(app)
        response = client.get(
            "/sse",
            headers={
                "Authorization": "Bearer trusted-token",
                "X-User-Name": "alice",
            },
        )

    assert response.status_code == 200
    assert response.json() == {"user_id": 7, "user_name": "alice"}
    auth_handler.assert_called_once()


def test_external_knowledge_mcp_custom_auth_can_use_user_name_header_without_bearer():
    async def context_response(request):
        user = mcp_server_module._external_knowledge_request_user.get()
        return JSONResponse({"user_id": user.id if user else None})

    def header_auth_handler(token, request):
        if token is not None or request.headers.get("X-User-Name") != "alice":
            return None
        return ExternalKnowledgeUser(id=7, user_name="alice")

    fake_streamable_app = Starlette(
        routes=[Route("/", context_response, methods=["GET"])]
    )

    original_handler = mcp_server_module._external_auth_handler
    try:
        set_external_knowledge_auth_handler(header_auth_handler)
        with patch.object(
            external_knowledge_mcp_server,
            "streamable_http_app",
            return_value=fake_streamable_app,
        ):
            app = _build_external_knowledge_mcp_app()
            client = TestClient(app)
            response = client.get("/sse", headers={"X-User-Name": "alice"})
    finally:
        set_external_knowledge_auth_handler(original_handler)

    assert response.status_code == 200
    assert response.json() == {"user_id": 7}


def test_external_knowledge_mcp_sync_auth_runs_in_threadpool():
    async def context_response(request):
        user = mcp_server_module._external_knowledge_request_user.get()
        return JSONResponse({"user_id": user.id if user else None})

    fake_streamable_app = Starlette(
        routes=[Route("/", context_response, methods=["GET"])]
    )
    auth_handler = patch(
        "app.mcp_server.server._external_auth_handler",
        return_value=ExternalKnowledgeUser(id=7, user_name="alice"),
    )

    with (
        patch.object(
            external_knowledge_mcp_server,
            "streamable_http_app",
            return_value=fake_streamable_app,
        ),
        auth_handler as sync_auth_handler,
        patch(
            "app.mcp_server.server.run_in_threadpool",
            new=AsyncMock(return_value=ExternalKnowledgeUser(id=7, user_name="alice")),
        ) as run_in_threadpool,
    ):
        app = _build_external_knowledge_mcp_app()
        client = TestClient(app)
        response = client.get("/sse", headers={"Authorization": "Bearer trusted-token"})

    assert response.status_code == 200
    assert response.json() == {"user_id": 7}
    run_in_threadpool.assert_awaited_once_with(
        sync_auth_handler,
        "trusted-token",
        ANY,
    )
    sync_auth_handler.assert_not_called()


def test_external_knowledge_mcp_auth_failure_returns_controlled_error():
    fake_streamable_app = Starlette(
        routes=[Route("/", lambda request: PlainTextResponse("ok"), methods=["GET"])]
    )

    with (
        patch.object(
            external_knowledge_mcp_server,
            "streamable_http_app",
            return_value=fake_streamable_app,
        ),
        patch(
            "app.mcp_server.server._external_auth_handler",
            side_effect=RuntimeError("auth backend down"),
        ),
    ):
        app = _build_external_knowledge_mcp_app()
        client = TestClient(app)
        response = client.get(
            "/sse",
            headers={"Authorization": "Bearer trusted-token"},
        )

    assert response.status_code == 401
    assert response.json() == {
        "error": "Authentication failed",
        "code": "unauthorized",
    }
    assert mcp_server_module._external_knowledge_request_user.get() is None
    assert mcp_server_module._external_knowledge_request_mount_path.get() is None


def test_external_knowledge_mcp_transport_is_rate_limited():
    fake_streamable_app = Starlette(
        routes=[Route("/", lambda request: PlainTextResponse("ok"), methods=["GET"])]
    )

    with (
        patch.object(settings, "EXTERNAL_KNOWLEDGE_MCP_RATE_LIMIT_ENABLED", True),
        patch(
            "app.mcp_server.external_knowledge_app.check_external_mcp_rate_limit",
            side_effect=[
                ExternalMcpRateLimitStatus.ALLOWED,
                ExternalMcpRateLimitStatus.LIMITED,
            ],
        ) as rate_limit_check,
        patch.object(
            external_knowledge_mcp_server,
            "streamable_http_app",
            return_value=fake_streamable_app,
        ),
        patch(
            "app.mcp_server.server._external_auth_handler",
            return_value=ExternalKnowledgeUser(id=7, user_name="alice"),
        ),
    ):
        app = _build_external_knowledge_mcp_app()
        client = TestClient(app)

        first_response = client.get("/sse", headers={"Authorization": "Bearer wg-test"})
        second_response = client.get(
            "/sse", headers={"Authorization": "Bearer wg-test"}
        )

    assert first_response.status_code == 200
    assert second_response.status_code == 429
    assert second_response.json() == {
        "error": "Rate limit exceeded",
        "code": "rate_limited",
    }
    assert rate_limit_check.call_count == 2


def test_external_knowledge_mcp_transport_fails_closed_when_rate_limit_unavailable():
    fake_streamable_app = Starlette(
        routes=[Route("/", lambda request: PlainTextResponse("ok"), methods=["GET"])]
    )

    with (
        patch.object(settings, "EXTERNAL_KNOWLEDGE_MCP_RATE_LIMIT_ENABLED", True),
        patch(
            "app.mcp_server.external_knowledge_app.check_external_mcp_rate_limit",
            return_value=ExternalMcpRateLimitStatus.UNAVAILABLE,
        ) as rate_limit_check,
        patch.object(
            external_knowledge_mcp_server,
            "streamable_http_app",
            return_value=fake_streamable_app,
        ),
        patch(
            "app.mcp_server.server._external_auth_handler",
            return_value=ExternalKnowledgeUser(id=7, user_name="alice"),
        ) as auth_handler,
    ):
        app = _build_external_knowledge_mcp_app()
        client = TestClient(app)
        response = client.get("/sse", headers={"Authorization": "Bearer wg-test"})

    assert response.status_code == 503
    assert response.json() == {
        "error": "Rate limit service unavailable",
        "code": "rate_limit_unavailable",
    }
    rate_limit_check.assert_called_once()
    auth_handler.assert_called_once()


def test_external_knowledge_document_file_applies_preauth_ip_rate_limit():
    verify_token = MagicMock()
    load_document_file = MagicMock()

    with (
        patch.object(
            settings, "EXTERNAL_KNOWLEDGE_MCP_DOWNLOAD_RATE_LIMIT_ENABLED", True
        ),
        patch(
            "app.mcp_server.external_knowledge_app.check_external_mcp_dimension_rate_limit",
            return_value=ExternalMcpRateLimitStatus.LIMITED,
        ) as rate_limit_check,
        patch(
            "app.mcp_server.external_knowledge_app.hash_rate_limit_value",
            return_value="hashed-ip",
        ),
        patch(
            "app.services.knowledge.external_document_access.verify_document_download_token",
            verify_token,
        ),
        patch(
            "app.services.knowledge.external_document_access.load_document_file_or_raise",
            load_document_file,
        ),
    ):
        app = _build_external_knowledge_mcp_app()
        client = TestClient(app)
        response = client.get("/documents/1/file")

    assert response.status_code == 429
    assert response.json() == {
        "error": "Rate limit exceeded",
        "code": "rate_limited",
    }
    rate_limit_check.assert_called_once()
    assert rate_limit_check.call_args.kwargs["namespace"] == "download_preauth_ip"
    assert rate_limit_check.call_args.kwargs["dimensions"] == ["ip:hashed-ip"]
    assert rate_limit_check.call_args.kwargs["limit"] == 300
    assert rate_limit_check.call_args.kwargs["window_seconds"] == 60
    verify_token.assert_not_called()
    load_document_file.assert_not_called()


def test_external_knowledge_document_file_applies_preauth_document_rate_limit():
    verify_token = MagicMock()
    load_document_file = MagicMock()

    with (
        patch.object(
            settings, "EXTERNAL_KNOWLEDGE_MCP_DOWNLOAD_RATE_LIMIT_ENABLED", True
        ),
        patch(
            "app.mcp_server.external_knowledge_app.check_external_mcp_dimension_rate_limit",
            side_effect=[
                ExternalMcpRateLimitStatus.ALLOWED,
                ExternalMcpRateLimitStatus.LIMITED,
            ],
        ) as rate_limit_check,
        patch(
            "app.mcp_server.external_knowledge_app.hash_rate_limit_value",
            return_value="hashed-ip",
        ),
        patch(
            "app.services.knowledge.external_document_access.verify_document_download_token",
            verify_token,
        ),
        patch(
            "app.services.knowledge.external_document_access.load_document_file_or_raise",
            load_document_file,
        ),
    ):
        app = _build_external_knowledge_mcp_app()
        client = TestClient(app)
        response = client.get("/documents/1/file")

    assert response.status_code == 429
    assert response.json() == {
        "error": "Rate limit exceeded",
        "code": "rate_limited",
    }
    assert rate_limit_check.call_count == 2
    first_call, second_call = rate_limit_check.call_args_list
    assert first_call.kwargs["namespace"] == "download_preauth_ip"
    assert first_call.kwargs["dimensions"] == ["ip:hashed-ip"]
    assert first_call.kwargs["limit"] == 300
    assert first_call.kwargs["window_seconds"] == 60
    assert second_call.kwargs["namespace"] == "download_preauth_document"
    assert second_call.kwargs["dimensions"] == ["ip:hashed-ip:document:1"]
    assert second_call.kwargs["limit"] == 60
    assert second_call.kwargs["window_seconds"] == 60
    verify_token.assert_not_called()
    load_document_file.assert_not_called()


def test_external_knowledge_document_file_fails_closed_when_preauth_limiter_unavailable():
    verify_token = MagicMock()

    with (
        patch.object(
            settings, "EXTERNAL_KNOWLEDGE_MCP_DOWNLOAD_RATE_LIMIT_ENABLED", True
        ),
        patch(
            "app.mcp_server.external_knowledge_app.check_external_mcp_dimension_rate_limit",
            return_value=ExternalMcpRateLimitStatus.UNAVAILABLE,
        ) as rate_limit_check,
        patch(
            "app.mcp_server.external_knowledge_app.hash_rate_limit_value",
            return_value="hashed-ip",
        ),
        patch(
            "app.services.knowledge.external_document_access.verify_document_download_token",
            verify_token,
        ),
    ):
        app = _build_external_knowledge_mcp_app()
        client = TestClient(app)
        response = client.get("/documents/1/file")

    assert response.status_code == 503
    assert response.json() == {
        "error": "Rate limit service unavailable",
        "code": "rate_limit_unavailable",
    }
    rate_limit_check.assert_called_once()
    assert rate_limit_check.call_args.kwargs["namespace"] == "download_preauth_ip"
    assert rate_limit_check.call_args.kwargs["dimensions"] == ["ip:hashed-ip"]
    verify_token.assert_not_called()


def test_external_knowledge_document_file_applies_postauth_rate_limit(test_user):
    token = create_document_download_token(
        user_id=test_user.id,
        document_id=1,
        disposition="inline",
    )
    load_document_file = MagicMock()

    with (
        patch.object(
            settings, "EXTERNAL_KNOWLEDGE_MCP_DOWNLOAD_RATE_LIMIT_ENABLED", True
        ),
        patch(
            "app.mcp_server.external_knowledge_app.check_external_mcp_dimension_rate_limit",
            side_effect=[
                ExternalMcpRateLimitStatus.ALLOWED,
                ExternalMcpRateLimitStatus.ALLOWED,
                ExternalMcpRateLimitStatus.LIMITED,
            ],
        ) as rate_limit_check,
        patch(
            "app.services.knowledge.external_document_access.load_document_file_or_raise",
            load_document_file,
        ),
    ):
        app = _build_external_knowledge_mcp_app()
        client = TestClient(app)
        response = client.get(
            "/documents/1/file",
            headers={DOWNLOAD_TOKEN_HEADER: token},
        )

    assert response.status_code == 429
    assert response.json() == {
        "error": "Rate limit exceeded",
        "code": "rate_limited",
    }
    assert rate_limit_check.call_count == 3
    assert rate_limit_check.call_args.kwargs["namespace"] == "download"
    load_document_file.assert_not_called()


def test_external_knowledge_document_file_fails_closed_when_postauth_limiter_unavailable(
    test_user,
):
    token = create_document_download_token(
        user_id=test_user.id,
        document_id=1,
        disposition="inline",
    )

    with (
        patch.object(
            settings, "EXTERNAL_KNOWLEDGE_MCP_DOWNLOAD_RATE_LIMIT_ENABLED", True
        ),
        patch(
            "app.mcp_server.external_knowledge_app.check_external_mcp_dimension_rate_limit",
            side_effect=[
                ExternalMcpRateLimitStatus.ALLOWED,
                ExternalMcpRateLimitStatus.ALLOWED,
                ExternalMcpRateLimitStatus.UNAVAILABLE,
            ],
        ) as rate_limit_check,
        patch(
            "app.services.knowledge.external_document_access.load_document_file_or_raise"
        ) as load_document_file,
    ):
        app = _build_external_knowledge_mcp_app()
        client = TestClient(app)
        response = client.get(
            "/documents/1/file",
            headers={DOWNLOAD_TOKEN_HEADER: token},
        )

    assert response.status_code == 503
    assert response.json() == {
        "error": "Rate limit service unavailable",
        "code": "rate_limit_unavailable",
    }
    assert rate_limit_check.call_count == 3
    assert rate_limit_check.call_args.kwargs["namespace"] == "download"
    load_document_file.assert_not_called()


def test_external_knowledge_document_file_downloads_with_short_lived_token(
    test_db,
    test_user,
):
    document = _create_external_document_with_attachment(test_db, test_user)
    token = create_document_download_token(
        user_id=test_user.id,
        document_id=document.id,
        disposition="inline",
    )

    with (
        patch("app.db.session.SessionLocal", return_value=NonClosingSession(test_db)),
        patch(
            "app.services.knowledge.external_document_access.KnowledgeService.get_knowledge_base",
            return_value=(object(), True),
        ),
        patch.object(
            context_service, "get_attachment_binary_data", return_value=b"%PDF bytes"
        ),
    ):
        app = _build_external_knowledge_mcp_app()
        client = TestClient(app)
        response = client.get(
            f"/documents/{document.id}/file",
            headers={DOWNLOAD_TOKEN_HEADER: token},
        )

    assert response.status_code == 200
    assert response.content == b"%PDF bytes"
    assert response.headers["content-type"] == "application/pdf"
    assert response.headers["content-disposition"].startswith("inline;")
    assert response.headers["x-content-type-options"] == "nosniff"


def test_external_knowledge_document_file_supports_attachment_disposition(
    test_db,
    test_user,
):
    document = _create_external_document_with_attachment(test_db, test_user)
    token = create_document_download_token(
        user_id=test_user.id,
        document_id=document.id,
        disposition="attachment",
    )

    with (
        patch("app.db.session.SessionLocal", return_value=NonClosingSession(test_db)),
        patch(
            "app.services.knowledge.external_document_access.KnowledgeService.get_knowledge_base",
            return_value=(object(), True),
        ),
        patch.object(context_service, "get_attachment_binary_data", return_value=b"x"),
    ):
        app = _build_external_knowledge_mcp_app()
        client = TestClient(app)
        response = client.get(
            f"/documents/{document.id}/file",
            headers={DOWNLOAD_TOKEN_HEADER: token},
        )

    assert response.status_code == 200
    assert response.headers["content-disposition"].startswith("attachment;")


def test_external_knowledge_document_file_rejects_expired_download_token(
    test_user,
):
    token = create_document_download_token(
        user_id=test_user.id,
        document_id=1,
        disposition="inline",
        expires_seconds=-1,
    )
    app = _build_external_knowledge_mcp_app()
    client = TestClient(app)

    response = client.get(
        "/documents/1/file",
        headers={DOWNLOAD_TOKEN_HEADER: token},
    )

    assert response.status_code == 401
    assert response.json() == {
        "error": "Invalid or expired download token",
        "code": "unauthorized",
    }


def test_external_knowledge_document_file_rejects_tampered_download_token(
    test_user,
):
    token = create_document_download_token(
        user_id=test_user.id,
        document_id=1,
        disposition="inline",
    )
    app = _build_external_knowledge_mcp_app()
    client = TestClient(app)

    response = client.get(
        "/documents/1/file",
        headers={DOWNLOAD_TOKEN_HEADER: f"{token}x"},
    )

    assert response.status_code == 401
    assert response.json() == {
        "error": "Invalid or expired download token",
        "code": "unauthorized",
    }


def test_external_knowledge_document_file_rechecks_permission_after_token_issue(
    test_db,
    test_user,
):
    document = _create_external_document_with_attachment(test_db, test_user)
    token = create_document_download_token(
        user_id=test_user.id,
        document_id=document.id,
        disposition="inline",
    )

    with (
        patch("app.db.session.SessionLocal", return_value=NonClosingSession(test_db)),
        patch(
            "app.services.knowledge.external_document_access.KnowledgeService.get_knowledge_base",
            return_value=(object(), False),
        ),
    ):
        app = _build_external_knowledge_mcp_app()
        client = TestClient(app)
        response = client.get(
            f"/documents/{document.id}/file",
            headers={DOWNLOAD_TOKEN_HEADER: token},
        )

    assert response.status_code == 403
    assert response.json() == {
        "error": "Access denied to this document",
        "code": "forbidden",
    }


def test_external_knowledge_document_file_reports_missing_binary_after_token_issue(
    test_db,
    test_user,
):
    document = _create_external_document_with_attachment(test_db, test_user)
    token = create_document_download_token(
        user_id=test_user.id,
        document_id=document.id,
        disposition="inline",
    )

    with (
        patch("app.db.session.SessionLocal", return_value=NonClosingSession(test_db)),
        patch(
            "app.services.knowledge.external_document_access.KnowledgeService.get_knowledge_base",
            return_value=(object(), True),
        ),
        patch.object(context_service, "get_attachment_binary_data", return_value=None),
    ):
        app = _build_external_knowledge_mcp_app()
        client = TestClient(app)
        response = client.get(
            f"/documents/{document.id}/file",
            headers={DOWNLOAD_TOKEN_HEADER: token},
        )

    assert response.status_code == 404
    assert response.json() == {
        "error": "Document file is unavailable",
        "code": "file_unavailable",
    }


def test_external_knowledge_document_file_rejects_inline_for_non_previewable_file(
    test_db,
    test_user,
):
    document = _create_external_document_with_attachment(
        test_db,
        test_user,
        file_name="archive.zip",
        mime_type="application/zip",
        file_extension=".zip",
        storage_key="attachments/archive.zip",
    )
    token = create_document_download_token(
        user_id=test_user.id,
        document_id=document.id,
        disposition="inline",
    )

    with (
        patch("app.db.session.SessionLocal", return_value=NonClosingSession(test_db)),
        patch(
            "app.services.knowledge.external_document_access.KnowledgeService.get_knowledge_base",
            return_value=(object(), True),
        ),
    ):
        app = _build_external_knowledge_mcp_app()
        client = TestClient(app)
        response = client.get(
            f"/documents/{document.id}/file",
            headers={DOWNLOAD_TOKEN_HEADER: token},
        )

    assert response.status_code == 415
    assert response.json() == {
        "error": "Document file is not previewable",
        "code": "unsupported_media_type",
    }


def test_external_knowledge_document_file_rejects_missing_download_token():
    app = _build_external_knowledge_mcp_app()
    client = TestClient(app)

    response = client.get("/documents/1/file")

    assert response.status_code == 401
    assert response.json() == {
        "error": "Invalid or expired download token",
        "code": "unauthorized",
    }


def test_external_knowledge_document_file_rejects_token_document_mismatch(test_user):
    token = create_document_download_token(
        user_id=test_user.id,
        document_id=2,
        disposition="inline",
    )
    app = _build_external_knowledge_mcp_app()
    client = TestClient(app)

    response = client.get(
        "/documents/1/file",
        headers={DOWNLOAD_TOKEN_HEADER: token},
    )

    assert response.status_code == 401
    assert response.json() == {
        "error": "Invalid or expired download token",
        "code": "unauthorized",
    }


def test_external_knowledge_mcp_public_paths_skip_auth_and_rate_limit_when_mounted():
    fake_streamable_app = Starlette(
        routes=[Route("/", lambda request: PlainTextResponse("ok"), methods=["GET"])]
    )

    with (
        patch.object(settings, "API_PREFIX", "/api"),
        patch.object(settings, "EXTERNAL_KNOWLEDGE_MCP_ENABLED", True),
        patch.object(settings, "EXTERNAL_KNOWLEDGE_MCP_RATE_LIMIT_ENABLED", True),
        patch(
            "app.mcp_server.server._build_mcp_app",
            return_value=fake_streamable_app,
        ),
        patch.object(
            external_knowledge_mcp_server,
            "streamable_http_app",
            return_value=fake_streamable_app,
        ),
        patch(
            "app.mcp_server.external_knowledge_app.check_external_mcp_rate_limit",
            return_value=ExternalMcpRateLimitStatus.ALLOWED,
        ) as rate_limit_check,
        patch(
            "app.mcp_server.server._external_auth_handler",
            return_value=ExternalKnowledgeUser(id=7, user_name="alice"),
        ) as auth_handler,
    ):
        app = create_app()
        client = TestClient(app)

        health_response = client.get(
            "/api/mcp/knowledge-external/health",
            headers={"Authorization": "Bearer trusted-token"},
        )
        root_response = client.get(
            "/api/mcp/knowledge-external/",
            headers={"Authorization": "Bearer trusted-token"},
        )

    assert health_response.status_code == 200
    assert root_response.status_code == 200
    assert rate_limit_check.call_count == 0
    auth_handler.assert_not_called()


def test_external_knowledge_mcp_transport_is_rate_limited_when_mounted():
    fake_streamable_app = Starlette(
        routes=[Route("/", lambda request: PlainTextResponse("ok"), methods=["GET"])]
    )

    with (
        patch.object(settings, "API_PREFIX", "/api"),
        patch.object(settings, "EXTERNAL_KNOWLEDGE_MCP_ENABLED", True),
        patch.object(settings, "EXTERNAL_KNOWLEDGE_MCP_RATE_LIMIT_ENABLED", True),
        patch(
            "app.mcp_server.server._build_mcp_app",
            return_value=fake_streamable_app,
        ),
        patch.object(
            external_knowledge_mcp_server,
            "streamable_http_app",
            return_value=fake_streamable_app,
        ),
        patch(
            "app.mcp_server.external_knowledge_app.check_external_mcp_rate_limit",
            return_value=ExternalMcpRateLimitStatus.ALLOWED,
        ) as rate_limit_check,
        patch(
            "app.mcp_server.server._external_auth_handler",
            return_value=ExternalKnowledgeUser(id=7, user_name="alice"),
        ),
    ):
        app = create_app()
        client = TestClient(app)
        response = client.get(
            "/api/mcp/knowledge-external/sse",
            headers={"Authorization": "Bearer trusted-token"},
        )

    assert response.status_code == 200
    rate_limit_check.assert_called_once()


def test_main_app_system_route_without_trailing_slash_does_not_redirect():
    fake_streamable_app = Starlette(
        routes=[Route("/", lambda request: PlainTextResponse("ok"), methods=["GET"])]
    )
    fake_system_app = Starlette(
        routes=[Route("/", lambda request: PlainTextResponse("ok"), methods=["GET"])]
    )

    with (
        patch.object(settings, "API_PREFIX", ""),
        patch.object(settings, "EXTERNAL_KNOWLEDGE_MCP_ENABLED", False),
        patch(
            "app.mcp_server.server._build_mcp_app",
            side_effect=[
                fake_system_app,
                fake_streamable_app,
                fake_streamable_app,
                fake_streamable_app,
                fake_streamable_app,
            ],
        ),
    ):
        app = create_app()

    client = TestClient(app)
    response = client.get("/mcp/system", follow_redirects=False)

    assert response.status_code == 200
    assert response.text == "ok"


def test_main_app_does_not_mount_external_knowledge_route_by_default():
    fake_streamable_app = Starlette(
        routes=[Route("/", lambda request: PlainTextResponse("ok"), methods=["GET"])]
    )

    with (
        patch.object(settings, "API_PREFIX", "/api"),
        patch.object(settings, "EXTERNAL_KNOWLEDGE_MCP_ENABLED", False),
        patch(
            "app.mcp_server.server._build_mcp_app",
            return_value=fake_streamable_app,
        ),
    ):
        app = create_app()

    client = TestClient(app)
    response = client.get("/api/mcp/knowledge-external/sse", follow_redirects=False)

    assert response.status_code == 404


def test_main_app_mounts_external_knowledge_route_when_enabled():
    fake_streamable_app = Starlette(
        routes=[Route("/", lambda request: PlainTextResponse("ok"), methods=["GET"])]
    )
    fake_external_app = Starlette(
        routes=[Route("/sse", lambda request: PlainTextResponse("ok"), methods=["GET"])]
    )

    with (
        patch.object(settings, "API_PREFIX", "/api"),
        patch.object(settings, "EXTERNAL_KNOWLEDGE_MCP_ENABLED", True),
        patch(
            "app.mcp_server.server._build_mcp_app",
            return_value=fake_streamable_app,
        ),
        patch(
            "app.mcp_server.server._build_external_knowledge_mcp_app",
            return_value=fake_external_app,
        ),
    ):
        app = create_app()

    client = TestClient(app)
    response = client.get("/api/mcp/knowledge-external/sse", follow_redirects=False)

    assert response.status_code == 200
    assert response.text == "ok"


def test_main_lifespan_skips_external_knowledge_mcp_by_default():
    with patch.object(settings, "EXTERNAL_KNOWLEDGE_MCP_ENABLED", False):
        mcp_lifespan_servers = _get_mcp_lifespan_servers()

    assert not any(
        mcp_server is external_knowledge_mcp_server
        for _, mcp_server in mcp_lifespan_servers
    )


def test_main_lifespan_starts_external_knowledge_mcp_when_enabled():
    with patch.object(settings, "EXTERNAL_KNOWLEDGE_MCP_ENABLED", True):
        mcp_lifespan_servers = _get_mcp_lifespan_servers()

    assert any(
        mcp_server is external_knowledge_mcp_server
        for _, mcp_server in mcp_lifespan_servers
    )
