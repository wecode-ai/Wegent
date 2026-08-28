# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Online document import against the observed DingTalk MCP response contract."""

import asyncio
import json
import logging
from contextlib import asynccontextmanager
from datetime import datetime
from io import BytesIO
from types import SimpleNamespace
from typing import Any, AsyncIterator
from unittest.mock import AsyncMock, MagicMock

import aiohttp
import pytest
from fastapi.testclient import TestClient
from openpyxl import Workbook
from sqlalchemy.orm import Session

from app.models.dingtalk_doc import DingTalkNodeSource, DingtalkSyncedNode
from app.models.knowledge import DocumentIndexStatus
from app.models.user import User
from app.schemas.dingtalk_doc import DingtalkDocNode
from app.schemas.knowledge import KnowledgeBaseCreate
from app.services.context import context_service
from app.services.dingtalk_doc_service import DingTalkDocService
from app.services.dingtalk_wikispace_service import DingTalkWikiSpaceService
from app.services.knowledge.external_document_import import (
    external_document_import_service,
    run_external_document_import,
)
from app.services.knowledge.external_document_providers import (
    DingTalkExternalDocumentProvider,
    ExternalDocumentFetchError,
    ExternalDocumentImportError,
)
from app.services.knowledge.knowledge_service import KnowledgeService

McpFixture = tuple[dict[str, Any], MagicMock]


@pytest.mark.asyncio
async def test_signed_download_does_not_log_credentials(
    test_db: Session,
    test_user: User,
    docs_mcp: McpFixture,
    spreadsheet_source: DingTalkExternalDocumentProvider,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    async def serve(reader, writer):
        await reader.readuntil(b"\r\n\r\n")
        writer.write(
            b"HTTP/1.1 200 OK\r\nContent-Length: 4\r\nConnection: close\r\n\r\ndata"
        )
        await writer.drain()
        writer.close()
        await writer.wait_closed()

    server = await asyncio.start_server(serve, "127.0.0.1", 0)
    port = server.sockets[0].getsockname()[1]
    monkeypatch.setattr(
        "app.services.knowledge.external_document_providers.validate_upstream_url",
        lambda url: None,
    )
    responses, _ = docs_mcp
    responses["export_data"] = {
        "status": "success",
        "data": {
            "status": "success",
            "fileName": "Base.xlsx",
            "downloadUrl": f"http://127.0.0.1:{port}/file?signature=private-download-token",
        },
    }
    async with server:
        with caplog.at_level(logging.INFO):
            content = await spreadsheet_source.fetch_content(
                test_db, test_user, "base-1"
            )
    assert content.content == b"data"
    assert "private-download-token" not in caplog.text


@pytest.fixture
async def spreadsheet_source(
    test_db: Session,
    test_user: User,
    docs_mcp: McpFixture,
    request: pytest.FixtureRequest,
) -> DingTalkExternalDocumentProvider:
    responses, _ = docs_mcp
    info = {
        "success": True,
        "nodeId": "base-1",
        "name": "Base",
        "nodeType": "file",
        "contentType": "ALIDOC",
        "extension": getattr(request, "param", "able"),
    }
    responses["list_nodes"] = {"success": True, "nodes": [info]}
    responses["get_document_info"] = info
    await DingTalkDocService.sync_dingtalk_docs(test_user, test_db)
    return DingTalkExternalDocumentProvider()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "spreadsheet_source,service_id,label",
    [("able", "ai_table", "AI Table"), ("axls", "table", "Table")],
    indirect=["spreadsheet_source"],
)
@pytest.mark.parametrize(
    "config", [{}, {"enabled": False, "url": "https://mcp.example.test/ai"}]
)
async def test_missing_export_configuration_does_not_block_text_import(
    test_db: Session,
    test_user: User,
    docs_mcp: McpFixture,
    online_source: DingTalkExternalDocumentProvider,
    spreadsheet_source: DingTalkExternalDocumentProvider,
    monkeypatch: pytest.MonkeyPatch,
    config: dict,
    service_id: str,
    label: str,
) -> None:
    responses, _ = docs_mcp
    monkeypatch.setattr(
        "app.services.user_mcp_service.UserMCPService.get_provider_service_config",
        lambda *args, **kwargs: (
            config
            if kwargs["service_id"] == service_id
            else {"enabled": True, "url": "https://mcp.example.test/docs"}
        ),
    )
    with pytest.raises(
        ExternalDocumentImportError, match=f"{label} MCP is not configured"
    ):
        spreadsheet_source.resolve_importable(test_db, test_user, "base-1")
    # The directory fixture above refreshes the cache; restore a text node through sync.
    info = {
        "success": True,
        "nodeId": "online-doc",
        "name": "Text",
        "nodeType": "file",
        "contentType": "ALIDOC",
        "extension": "adoc",
    }
    responses["list_nodes"] = {"success": True, "nodes": [info]}
    responses["get_document_info"] = info
    await DingTalkDocService.sync_dingtalk_docs(test_user, test_db)
    assert (
        await online_source.fetch_content(test_db, test_user, "online-doc")
    ).file_extension == "md"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "data",
    [
        {"status": "failed", "downloadUrl": "https://files.example.test/secret"},
        {"status": "pending"},
        {
            "status": "success",
            "fileName": "Base.zip",
            "downloadUrl": "https://files.example.test/secret",
        },
        {"status": "success", "fileName": "Base.xlsx"},
        {"status": "success", "fileName": "Base.xlsx", "taskId": " "},
    ],
)
async def test_invalid_export_results_are_not_downloaded(
    test_db: Session,
    test_user: User,
    docs_mcp: McpFixture,
    spreadsheet_source: DingTalkExternalDocumentProvider,
    signed_download: list,
    data: dict,
) -> None:
    responses, session = docs_mcp
    responses["export_data"] = {"status": "success", "data": data}
    with pytest.raises(ExternalDocumentFetchError):
        await spreadsheet_source.fetch_content(test_db, test_user, "base-1")
    assert signed_download == []
    assert (
        sum(c.args[0] == "export_data" for c in session.call_tool.await_args_list) == 1
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("status", ["pending", "success"])
async def test_export_polling_is_bounded_without_restarting_job(
    test_db: Session,
    test_user: User,
    docs_mcp: McpFixture,
    spreadsheet_source: DingTalkExternalDocumentProvider,
    monkeypatch: pytest.MonkeyPatch,
    status: str,
) -> None:
    responses, session = docs_mcp
    responses["export_data"] = {
        "status": "success",
        "data": {"status": status, "taskId": "pending-job", "fileName": "Base.xlsx"},
    }
    monkeypatch.setattr(
        "app.services.knowledge.external_document_providers.asyncio.sleep", AsyncMock()
    )
    with pytest.raises(ExternalDocumentFetchError, match="timed out"):
        await spreadsheet_source.fetch_content(test_db, test_user, "base-1")
    calls = [
        c.args[1]
        for c in session.call_tool.await_args_list
        if c.args[0] == "export_data"
    ]
    assert len(calls) == 6
    assert all(c["taskId"] == "pending-job" and "scope" not in c for c in calls[1:])


@pytest.mark.asyncio
@pytest.mark.parametrize("response_id", ["other-job", None])
async def test_export_rejects_changed_or_missing_task_identity(
    test_db: Session,
    test_user: User,
    docs_mcp: McpFixture,
    spreadsheet_source: DingTalkExternalDocumentProvider,
    signed_download: list,
    response_id: str | None,
) -> None:
    responses, _ = docs_mcp
    responses["export_data"] = lambda args: {
        "status": "success",
        "data": (
            {
                "status": "success",
                "fileName": "Base.xlsx",
                "taskId": response_id,
                "downloadUrl": "https://files.example.test/base",
            }
            if "taskId" in args
            else {"status": "pending", "taskId": "export-1"}
        ),
    }

    with pytest.raises(ExternalDocumentFetchError, match="task identity changed"):
        await spreadsheet_source.fetch_content(test_db, test_user, "base-1")
    assert signed_download == []


@pytest.mark.asyncio
@pytest.mark.parametrize("envelope", [{"success": True}, {"status": "failed"}, {}])
async def test_ai_export_requires_its_own_success_envelope(
    test_db: Session,
    test_user: User,
    docs_mcp: McpFixture,
    spreadsheet_source: DingTalkExternalDocumentProvider,
    signed_download: list,
    envelope: dict,
) -> None:
    responses, _ = docs_mcp
    responses["export_data"] = {
        **envelope,
        "data": {
            "status": "success",
            "fileName": "Base.xlsx",
            "downloadUrl": "https://files.example.test/base",
        },
    }
    with pytest.raises(ExternalDocumentFetchError, match="unsuccessful response"):
        await spreadsheet_source.fetch_content(test_db, test_user, "base-1")
    assert signed_download == []


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "url, status_code, limit",
    [
        ("https://127.0.0.1/private?signature=secret", 200, 100),
        ("http://files.example.test/file?signature=secret", 200, 100),
        ("https://files.example.test/file?signature=secret", 403, 100),
        ("https://files.example.test/file?signature=secret", 302, 100),
        ("https://files.example.test/file?signature=secret", 200, 0),
    ],
)
async def test_unsafe_or_failed_download_never_returns_content_or_leaks_url(
    test_db: Session,
    test_user: User,
    docs_mcp: McpFixture,
    spreadsheet_source: DingTalkExternalDocumentProvider,
    monkeypatch: pytest.MonkeyPatch,
    url: str,
    status_code: int,
    limit: int,
) -> None:
    responses, _ = docs_mcp
    responses["export_data"] = {
        "status": "success",
        "data": {"status": "success", "fileName": "Base.xlsx", "downloadUrl": url},
    }
    mock_download(monkeypatch, status=status_code, body=b"oversized")
    monkeypatch.setattr(
        "socket.getaddrinfo",
        lambda host, *args: [
            (
                2,
                1,
                6,
                "",
                ("127.0.0.1" if host == "127.0.0.1" else "93.184.216.34", 443),
            )
        ],
    )
    monkeypatch.setattr("app.core.config.settings.MAX_UPLOAD_FILE_SIZE_MB", limit)
    with pytest.raises(ExternalDocumentFetchError) as error:
        await spreadsheet_source.fetch_content(test_db, test_user, "base-1")
    assert "signature" not in str(error.value)
    assert "secret" not in str(error.value)


def mock_download(monkeypatch, status=200, body=b"exported-workbook") -> list:
    requests = []

    async def chunks(size):
        yield body

    @asynccontextmanager
    async def get(url, **kwargs):
        requests.append(SimpleNamespace(url=url, **kwargs))
        yield SimpleNamespace(
            status=status,
            headers={},
            content=SimpleNamespace(iter_chunked=chunks),
        )

    monkeypatch.setattr(
        aiohttp,
        "ClientSession",
        lambda **kwargs: SimpleNamespace(get=get, close=AsyncMock()),
    )
    return requests


@pytest.fixture
def signed_download(monkeypatch: pytest.MonkeyPatch) -> list:
    requests = mock_download(monkeypatch)
    monkeypatch.setattr(
        "socket.getaddrinfo", lambda *args: [(2, 1, 6, "", ("93.184.216.34", 443))]
    )
    return requests


@pytest.mark.asyncio
@pytest.mark.parametrize("initial_status", ["pending", "success"])
async def test_ai_table_exports_whole_base_and_polls_same_task(
    test_db: Session,
    test_user: User,
    docs_mcp: McpFixture,
    signed_download: list,
    initial_status: str,
) -> None:
    responses, session = docs_mcp
    info = {
        "success": True,
        "nodeId": "base-1",
        "name": "Project",
        "nodeType": "file",
        "contentType": "ALIDOC",
        "extension": "able",
    }
    responses["list_nodes"] = {"success": True, "nodes": [info]}
    responses["get_document_info"] = info
    responses["export_data"] = lambda args: {
        "status": "success",
        "error": {},
        "data": (
            {
                "status": "success",
                "fileName": "Project.xlsx",
                "taskId": "export-1",
                "downloadUrl": "https://files.example.test/project",
            }
            if "taskId" in args
            else {
                "status": initial_status,
                "fileName": "Project.xlsx",
                "taskId": "export-1",
            }
        ),
    }
    await DingTalkDocService.sync_dingtalk_docs(test_user, test_db)

    content = await DingTalkExternalDocumentProvider().fetch_content(
        test_db, test_user, "base-1"
    )

    assert content.file_extension == "xlsx"
    assert content.content == b"exported-workbook"
    calls = [
        call.args[1]
        for call in session.call_tool.await_args_list
        if call.args[0] == "export_data"
    ]
    assert calls == [
        {"baseId": "base-1", "scope": "all", "format": "excel", "timeoutMs": 30000},
        {"baseId": "base-1", "taskId": "export-1", "timeoutMs": 30000},
    ]
    assert len(signed_download) == 1
    assert session.urls[-2:] == [
        "https://mcp.example.test/docs",
        "https://mcp.example.test/ai_table",
    ]


@pytest.mark.parametrize("spreadsheet_source", ["able", "axls"], indirect=True)
def test_exported_workbook_is_saved_and_previewable_before_index_success(
    test_client: TestClient,
    test_token: str,
    test_db: Session,
    test_user: User,
    docs_mcp: McpFixture,
    spreadsheet_source: DingTalkExternalDocumentProvider,
    signed_download: list,
    dispatched: list[int],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    workbook = Workbook()
    workbook.active.append(["Project", "Status"])
    workbook.active.append(["AI export preview", "Ready"])
    workbook.create_sheet("Second sheet").append(["Other sheet content"])
    buffer = BytesIO()
    workbook.save(buffer)
    workbook.close()
    body = buffer.getvalue()
    mock_download(monkeypatch, body=body)
    responses, _ = docs_mcp
    responses["submit_export_job"] = {"success": True, "jobId": "job-1"}
    responses["query_export_job"] = {
        "success": True,
        "status": "success",
        "jobId": "job-1",
        "downloadUrl": "https://files.example.test/base",
    }
    responses["export_data"] = lambda args: {
        "status": "success",
        "error": {},
        "data": {
            "status": "success",
            "fileName": "Base.xlsx",
            "taskId": "export-1",
            **(
                {"downloadUrl": "https://files.example.test/base"}
                if "taskId" in args
                else {}
            ),
        },
    }
    # No retrieval configuration: indexing will fail without contacting RAG.
    kb_id = KnowledgeService.create_knowledge_base(
        test_db, test_user.id, KnowledgeBaseCreate(name="export-preview-kb")
    )
    document = external_document_import_service.import_document(
        test_db, test_user, kb_id, "dingtalk", "base-1"
    )
    document_id = document.id

    run_external_document_import(
        test_db, document, test_user, generation=document.index_generation
    )

    current = KnowledgeService.get_document(test_db, document_id, test_user.id)
    assert current.file_extension == "xlsx"
    assert current.file_size == len(body)
    assert current.index_status == DocumentIndexStatus.FAILED
    attachment = context_service.get_context(
        test_db, current.attachment_id, test_user.id
    )
    assert context_service.get_attachment_binary_data(test_db, attachment) == body
    response = test_client.get(
        f"/api/knowledge-bases/{kb_id}/documents/{document_id}/detail",
        headers={"Authorization": f"Bearer {test_token}"},
        params={"include_summary": False},
    )
    assert response.status_code == 200, response.text
    assert "AI export preview" in response.json()["content"]
    assert "Other sheet content" in response.json()["content"]
    repeated = external_document_import_service.import_document(
        test_db, test_user, kb_id, "dingtalk", "base-1"
    )
    assert repeated.id == document_id


@pytest.mark.asyncio
@pytest.mark.parametrize("spreadsheet_source", ["axls"], indirect=True)
async def test_sheet_exports_once_and_queries_the_same_job(
    test_db: Session,
    test_user: User,
    docs_mcp: McpFixture,
    spreadsheet_source: DingTalkExternalDocumentProvider,
    signed_download: list,
) -> None:
    responses, session = docs_mcp
    responses["submit_export_job"] = {"success": True, "jobId": "job-1"}
    replies = iter(
        [
            {"success": True, "status": "pending", "jobId": "job-1"},
            {
                "success": True,
                "status": "success",
                "jobId": "job-1",
                "downloadUrl": "https://files.example.test/sheet",
            },
        ]
    )
    responses["query_export_job"] = lambda args: next(replies)
    session.call_tool.reset_mock()

    content = await spreadsheet_source.fetch_content(test_db, test_user, "base-1")

    assert content.file_extension == "xlsx"
    assert content.content == b"exported-workbook"
    assert [call.args for call in session.call_tool.await_args_list] == [
        ("get_document_info", {"nodeId": "base-1"}),
        ("submit_export_job", {"nodeId": "base-1", "exportFormat": "xlsx"}),
        ("query_export_job", {"jobId": "job-1"}),
        ("query_export_job", {"jobId": "job-1"}),
    ]
    assert session.urls[-1] == "https://mcp.example.test/table"


@pytest.mark.asyncio
@pytest.mark.parametrize("spreadsheet_source", ["axls"], indirect=True)
@pytest.mark.parametrize(
    "tool,response",
    [
        ("submit_export_job", {"success": True, "jobId": " "}),
        ("query_export_job", {"success": False, "status": "success", "jobId": "job-1"}),
        ("query_export_job", {"success": True, "status": "failed", "jobId": "job-1"}),
        (
            "query_export_job",
            {"success": True, "status": "success", "jobId": "other-job"},
        ),
    ],
)
async def test_sheet_rejects_invalid_export_without_downloading(
    test_db: Session,
    test_user: User,
    docs_mcp: McpFixture,
    spreadsheet_source: DingTalkExternalDocumentProvider,
    signed_download: list,
    tool: str,
    response: dict,
) -> None:
    responses, _ = docs_mcp
    responses["submit_export_job"] = {"success": True, "jobId": "job-1"}
    responses[tool] = {**response, "downloadUrl": "https://files.example.test/sheet"}
    with pytest.raises(ExternalDocumentFetchError):
        await spreadsheet_source.fetch_content(test_db, test_user, "base-1")
    assert signed_download == []


@pytest.mark.asyncio
@pytest.mark.parametrize("spreadsheet_source", ["axls"], indirect=True)
@pytest.mark.parametrize("status", ["pending", "success"])
async def test_sheet_waiting_for_download_respects_import_timeout(
    test_db: Session,
    test_user: User,
    docs_mcp: McpFixture,
    spreadsheet_source: DingTalkExternalDocumentProvider,
    monkeypatch: pytest.MonkeyPatch,
    status: str,
) -> None:
    responses, session = docs_mcp
    responses["submit_export_job"] = {"success": True, "jobId": "job-1"}
    responses["query_export_job"] = {
        "success": True,
        "status": status,
        "jobId": "job-1",
    }
    monkeypatch.setattr(
        "app.services.knowledge.external_document_providers.EXTERNAL_DOCUMENT_MCP_READ_TIMEOUT_SECONDS",
        0.01,
    )
    with pytest.raises(ExternalDocumentFetchError, match="timed out"):
        await spreadsheet_source.fetch_content(test_db, test_user, "base-1")
    assert (
        sum(c.args[0] == "submit_export_job" for c in session.call_tool.await_args_list)
        == 1
    )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "extension", ["pdf", "docx", "pptx", "xlsx", "csv", "txt", "md"]
)
async def test_regular_file_download_preserves_bytes_and_extension(
    test_db: Session,
    test_user: User,
    docs_mcp: McpFixture,
    monkeypatch: pytest.MonkeyPatch,
    extension: str,
) -> None:
    responses, session = docs_mcp
    info = {
        "success": True,
        "nodeId": "file-pdf",
        "name": "Report.pdf",
        "nodeType": "file",
        "contentType": "DOCUMENT",
        "extension": extension,
    }
    responses["list_nodes"] = {"success": True, "nodes": [info]}
    responses["get_document_info"] = info
    responses["download_file"] = {
        "success": True,
        "resourceUrl": ["https://files.example.test/report"],
        "headers": {"x-download-signature": "test-signature"},
    }
    requests = mock_download(monkeypatch, body=b"%PDF-test-content")
    monkeypatch.setattr(
        "socket.getaddrinfo", lambda *args: [(2, 1, 6, "", ("93.184.216.34", 443))]
    )
    await DingTalkDocService.sync_dingtalk_docs(test_user, test_db)

    content = await DingTalkExternalDocumentProvider().fetch_content(
        test_db, test_user, "file-pdf"
    )

    assert content.file_extension == extension
    assert content.name == "Report.pdf"
    assert content.content == b"%PDF-test-content"
    assert requests[0].headers == {"x-download-signature": "test-signature"}
    assert requests[0].allow_redirects is False
    assert session.call_tool.await_args_list[-1].args == (
        "download_file",
        {"nodeId": "file-pdf"},
    )


@pytest.fixture
def docs_mcp(monkeypatch: pytest.MonkeyPatch) -> McpFixture:
    """Replace only the external MCP transport and account configuration."""
    responses: dict[str, Any] = {}
    session = MagicMock()
    session.__aenter__ = AsyncMock(return_value=session)
    session.__aexit__ = AsyncMock(return_value=None)
    session.initialize = AsyncMock()
    session.list_tools = AsyncMock(return_value=SimpleNamespace(tools=[]))
    session.urls = []

    async def call_tool(name: str, arguments: dict[str, Any]) -> SimpleNamespace:
        payload = responses[name]
        if callable(payload):
            payload = payload(arguments)
        if isinstance(payload, SimpleNamespace):
            return payload
        return SimpleNamespace(
            isError=False,
            content=[SimpleNamespace(type="text", text=json.dumps(payload))],
        )

    session.call_tool = AsyncMock(side_effect=call_tool)

    @asynccontextmanager
    async def transport(**kwargs: Any) -> AsyncIterator[tuple[None, None, None]]:
        session.urls.append(kwargs["url"])
        yield (None, None, None)

    monkeypatch.setattr("mcp.ClientSession", lambda *args, **kwargs: session)
    monkeypatch.setattr("mcp.client.streamable_http.streamablehttp_client", transport)
    monkeypatch.setattr(
        "app.services.user_mcp_service.UserMCPService.get_provider_service_config",
        lambda *args, **kwargs: {
            "enabled": True,
            "url": f"https://mcp.example.test/{kwargs['service_id']}",
        },
    )
    return responses, session


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "cached_type, cached_content_type, cached_extension",
    [
        ("doc", "ALIDOC", None),
        ("doc", "ALIDOC", ""),
        ("file", "ALIDOC", ""),
        ("doc", "ALIDOC", "appt"),
        ("doc", "", "adoc"),
    ],
)
async def test_manual_refresh_makes_online_document_importable_in_place(
    test_db: Session,
    test_user: User,
    docs_mcp: McpFixture,
    cached_type: str,
    cached_content_type: str,
    cached_extension: str | None,
) -> None:
    responses, _ = docs_mcp
    node = DingtalkSyncedNode(
        user_id=test_user.id,
        dingtalk_node_id="online-doc",
        name="Online document",
        doc_url="https://alidocs.dingtalk.com/i/nodes/online-doc",
        node_type=cached_type,
        content_type=cached_content_type,
        raw_metadata=(
            None
            if cached_extension is None
            else {"extension": cached_extension} if cached_extension else {}
        ),
        last_synced_at=datetime.now(),
    )
    test_db.add(node)
    test_db.commit()
    original_id = node.id
    with pytest.raises(ExternalDocumentImportError):
        DingTalkExternalDocumentProvider().resolve_importable(
            test_db, test_user, "online-doc"
        )
    responses["list_nodes"] = {
        "success": True,
        "nodes": [
            {
                "nodeId": "online-doc",
                "name": "Online document",
                "nodeType": "file",
                "contentType": "ALIDOC",
                "extension": "adoc",
            }
        ],
    }

    await DingTalkDocService.sync_dingtalk_docs(test_user, test_db)

    nodes = DingTalkDocService.get_dingtalk_docs(test_user.id, test_db)
    assert [(item.id, item.node_type) for item in nodes] == [(original_id, "doc")]
    metadata = DingTalkExternalDocumentProvider().resolve_importable(
        test_db, test_user, "online-doc"
    )
    assert metadata["resource_id"] == "online-doc"


@pytest.fixture
async def online_source(
    test_db: Session, test_user: User, docs_mcp: McpFixture
) -> DingTalkExternalDocumentProvider:
    responses, _ = docs_mcp
    info = {
        "success": True,
        "nodeId": "online-doc",
        "name": "Online document",
        "nodeType": "file",
        "contentType": "ALIDOC",
        "extension": "adoc",
    }
    responses["list_nodes"] = {"success": True, "nodes": [info]}
    responses["get_document_info"] = info
    responses["get_document_content"] = {
        "success": True,
        "title": "Online document",
        "nodeId": "online-doc",
        "markdown": "# 正文\n\n只导入这段内容。",
    }
    await DingTalkDocService.sync_dingtalk_docs(test_user, test_db)
    return DingTalkExternalDocumentProvider()


@pytest.mark.asyncio
async def test_import_reads_metadata_then_returns_only_markdown(
    test_db: Session,
    test_user: User,
    docs_mcp: McpFixture,
    online_source: DingTalkExternalDocumentProvider,
) -> None:
    _, session = docs_mcp
    session.call_tool.reset_mock()

    content = await online_source.fetch_content(test_db, test_user, "online-doc")

    assert content.content.decode("utf-8") == "# 正文\n\n只导入这段内容。"
    assert content.file_extension == "md"
    assert [call.args for call in session.call_tool.await_args_list] == [
        ("get_document_info", {"nodeId": "online-doc"}),
        ("get_document_content", {"nodeId": "online-doc", "format": "markdown"}),
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize("source", ["docs", "wikispace"])
async def test_both_sources_offer_supported_document_formats(
    test_db: Session, test_user: User, docs_mcp: McpFixture, source: str
) -> None:
    responses, _ = docs_mcp
    cases = [
        ("text", "file", "ALIDOC", "adoc", "doc"),
        ("lowercase", "file", "alidoc", "ADOC", "doc"),
        ("sheet", "file", "ALIDOC", "axls", "file"),
        ("table", "file", "ALIDOC", "able", "file"),
        ("pdf", "file", "FILE", "pdf", "file"),
        ("word", "file", "FILE", "docx", "file"),
        ("missing-extension", "doc", "ALIDOC", None, "file"),
        ("missing-type", "doc", None, "adoc", "file"),
        ("unknown", "other", None, None, "file"),
        ("folder", "folder", "ALIDOC", "adoc", "folder"),
    ]
    nodes = [
        {
            "nodeId": name,
            "name": name,
            "nodeType": kind,
            "contentType": content_type,
            "extension": extension,
        }
        for name, kind, content_type, extension, _ in cases
    ]
    responses["list_nodes"] = lambda args: {
        "success": True,
        "nodes": nodes if not args.get("folderId") else [],
    }
    responses["list_wikiSpaces"] = {
        "success": True,
        "wikiSpaces": [{"workspaceId": "space-1", "name": "Space"}],
    }
    if source == "docs":
        await DingTalkDocService.sync_dingtalk_docs(test_user, test_db)
        synced = DingTalkDocService.get_dingtalk_docs(test_user.id, test_db)
    else:
        await DingTalkWikiSpaceService.sync_wikispace_nodes(test_user, test_db)
        synced = DingTalkWikiSpaceService.get_wikispace_nodes(test_user.id, test_db)

    actual = {node.dingtalk_node_id: node.node_type for node in synced}
    for name, _, _, _, expected in cases:
        assert actual[name] == expected
        if name in {"text", "lowercase", "sheet", "table", "pdf", "word"}:
            assert (
                DingTalkExternalDocumentProvider().resolve_importable(
                    test_db, test_user, name
                )["resource_id"]
                == name
            )
        else:
            with pytest.raises(ExternalDocumentImportError):
                DingTalkExternalDocumentProvider().resolve_importable(
                    test_db, test_user, name
                )


@pytest.mark.asyncio
@pytest.mark.parametrize("extension", ["appt", "pdf", None])
async def test_live_metadata_blocks_unsupported_content_even_with_stale_cache(
    test_db: Session,
    test_user: User,
    docs_mcp: McpFixture,
    online_source: DingTalkExternalDocumentProvider,
    extension: str | None,
) -> None:
    responses, session = docs_mcp
    responses["get_document_info"] = {
        **responses["get_document_info"],
        "extension": extension,
    }
    session.call_tool.reset_mock()

    with pytest.raises(ExternalDocumentFetchError, match="cannot be imported"):
        await online_source.fetch_content(test_db, test_user, "online-doc")

    assert [call.args[0] for call in session.call_tool.await_args_list] == [
        "get_document_info"
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize("tool", ["get_document_info", "get_document_content"])
@pytest.mark.parametrize(
    "payload",
    [
        {"success": False, "markdown": "Must not import an unsuccessful response"},
        {"markdown": "Missing success flag"},
        {"success": "true", "markdown": "Non-boolean success flag"},
        [],
        "Not a JSON response object",
        SimpleNamespace(
            isError=True,
            content=[
                SimpleNamespace(
                    type="text", text='{"success": true, "markdown": "Error payload"}'
                )
            ],
        ),
        SimpleNamespace(
            isError=False, content=[SimpleNamespace(type="text", text="bad JSON")]
        ),
    ],
)
async def test_mcp_failures_are_never_imported_as_content(
    test_db: Session,
    test_user: User,
    docs_mcp: McpFixture,
    online_source: DingTalkExternalDocumentProvider,
    tool: str,
    payload: Any,
) -> None:
    responses, _ = docs_mcp
    responses[tool] = payload

    with pytest.raises(ExternalDocumentFetchError):
        await online_source.fetch_content(test_db, test_user, "online-doc")


@pytest.mark.asyncio
@pytest.mark.parametrize("markdown", [None, "", " \n\t", 123, {"text": "wrong type"}])
async def test_empty_or_invalid_markdown_is_not_imported(
    test_db: Session,
    test_user: User,
    docs_mcp: McpFixture,
    online_source: DingTalkExternalDocumentProvider,
    markdown: Any,
) -> None:
    responses, _ = docs_mcp
    responses["get_document_content"] = {"success": True, "markdown": markdown}

    with pytest.raises(ExternalDocumentFetchError, match="empty or unreadable"):
        await online_source.fetch_content(test_db, test_user, "online-doc")


@pytest.mark.asyncio
@pytest.mark.parametrize("source", list(DingTalkNodeSource))
async def test_sync_preserves_original_metadata_and_replaces_snapshot(
    source: DingTalkNodeSource, test_db: Session, test_user: User, docs_mcp: McpFixture
) -> None:
    """Both sync paths retain upstream JSON before ID/parent normalization."""
    root = {"workspaceId": " WS1 ", "name": "Knowledge", "unknown": [1, None]}
    parent = {"nodeId": "parent", "name": "Parent", "nodeType": "folder"}
    child = {
        "id": " child ",
        "name": "Document",
        "nodeType": "file",
        "extension": " PDF ",
        "updateTime": 1700000000,
        "flag": True,
        "unknown": {"values": [False, None, "原始内容"]},
        "_raw_metadata": "upstream field must not collide",
    }

    responses, _ = docs_mcp
    responses["list_wikiSpaces"] = {"items": [root]}
    responses["list_nodes"] = lambda args: {
        "items": [child] if args.get("folderId") else [parent]
    }
    sync = (
        DingTalkDocService.sync_dingtalk_docs
        if source == DingTalkNodeSource.DOCS
        else DingTalkWikiSpaceService.sync_wikispace_nodes
    )
    await sync(test_user, test_db)
    test_db.expire_all()
    node = (
        test_db.query(DingtalkSyncedNode)
        .filter_by(user_id=test_user.id, source=source.value, dingtalk_node_id="child")
        .one()
    )
    assert node.raw_metadata == child
    assert node.parent_node_id == "parent"
    payload = DingtalkDocNode.model_validate(node).model_dump()
    assert payload["extension"] == "pdf"
    assert "raw_metadata" not in payload
    if source == DingTalkNodeSource.WIKISPACE:
        cached_root = (
            test_db.query(DingtalkSyncedNode)
            .filter_by(
                user_id=test_user.id, source=source.value, dingtalk_node_id="WS1"
            )
            .one()
        )
        assert cached_root.raw_metadata == root

    # JSON boolean and number values are distinct even though True == 1.
    child["flag"] = 1
    await sync(test_user, test_db)
    test_db.refresh(node)
    assert type(node.raw_metadata["flag"]) is int

    # A refresh replaces metadata even when indexed fields are unchanged.
    child.pop("unknown")
    child["newField"] = {"version": 2}
    await sync(test_user, test_db)
    test_db.refresh(node)
    assert node.raw_metadata == child
    assert node.extension == "pdf"

    child.pop("extension")
    await sync(test_user, test_db)
    test_db.refresh(node)
    assert node.raw_metadata == child
    assert DingtalkDocNode.model_validate(node).extension == ""
