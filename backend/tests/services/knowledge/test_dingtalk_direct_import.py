# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Node-based imports through the Knowledge MCP public tool."""

import asyncio
import json
import threading
from collections.abc import Awaitable, Callable
from contextlib import asynccontextmanager, nullcontext
from types import SimpleNamespace
from typing import Any, AsyncIterator
from unittest.mock import AsyncMock

import pytest
from sqlalchemy.orm import Session, sessionmaker

from app.mcp_server.auth import TaskTokenInfo
from app.mcp_server.tools import knowledge
from app.models.dingtalk_doc import DingtalkSyncedNode
from app.models.kind import Kind
from app.models.knowledge import DocumentIndexStatus, KnowledgeDocument
from app.models.user import User
from app.schemas.knowledge import KnowledgeBaseCreate, KnowledgeFolderCreate
from app.services.knowledge.external_document_providers import (
    DingTalkExternalDocumentProvider,
)
from app.services.knowledge.folder_service import KnowledgeFolderService
from app.services.knowledge.knowledge_service import KnowledgeService

ImportTool = Callable[..., Awaitable[dict[str, Any]]]


@pytest.fixture
def live_docs(monkeypatch: pytest.MonkeyPatch) -> SimpleNamespace:
    info = {
        "success": True,
        "name": "Live document",
        "nodeType": "file",
        "contentType": "ALIDOC",
        "extension": "adoc",
        "updateTime": 1800000001,
    }
    session = SimpleNamespace(users=[], info=info)

    async def call_tool(name: str, arguments: dict[str, Any]) -> SimpleNamespace:
        assert name in {"get_document_info", "get_document_content"}
        return SimpleNamespace(
            isError=False,
            content=[
                SimpleNamespace(
                    type="text",
                    text=json.dumps(
                        session.info
                        if name == "get_document_info"
                        else {"success": True, "markdown": "# Unsynced content"}
                    ),
                )
            ],
        )

    session.call_tool = AsyncMock(side_effect=call_tool)

    @asynccontextmanager
    async def open_session(
        db: Session, user: User, service_id: str
    ) -> AsyncIterator[SimpleNamespace]:
        session.users.append(user.id)
        yield session

    monkeypatch.setattr(
        "app.services.knowledge.external_document_providers.open_dingtalk_session",
        open_session,
    )
    return session


@pytest.fixture
def import_tool(
    test_db: Session, test_user: User, monkeypatch: pytest.MonkeyPatch
) -> ImportTool:
    monkeypatch.setattr(knowledge, "SessionLocal", lambda: nullcontext(test_db))
    token = TaskTokenInfo(
        task_id=1, subtask_id=1, user_id=test_user.id, user_name=test_user.user_name
    )

    async def invoke(
        kb_id: int, node_id: str = "unsynced-node", folder_id: int = 0
    ) -> dict[str, Any]:
        return await asyncio.to_thread(
            knowledge.import_dingtalk_document, token, kb_id, node_id, folder_id
        )

    return invoke


async def test_unsynced_document_body_uses_live_metadata(
    test_db: Session, test_user: User, live_docs: SimpleNamespace
) -> None:
    content = await DingTalkExternalDocumentProvider().fetch_content(
        test_db, test_user, "unsynced-node"
    )

    assert content.name == "Live document"
    assert content.content == b"# Unsynced content"
    assert content.metadata["resource_id"] == "unsynced-node"
    assert content.metadata["source_update_time"] == 1800000001
    assert test_db.query(DingtalkSyncedNode).count() == 0
    assert [call.args[0] for call in live_docs.call_tool.await_args_list] == [
        "get_document_info",
        "get_document_content",
    ]


@pytest.mark.parametrize("auto_sync", [False, True])
async def test_import_unsynced_node_preserves_kb_configuration(
    test_db: Session,
    test_user: User,
    live_docs: SimpleNamespace,
    import_tool: ImportTool,
    dispatched: list[int],
    auto_sync: bool,
) -> None:
    kb_id = KnowledgeService.create_knowledge_base(
        test_db,
        test_user.id,
        KnowledgeBaseCreate(name="Direct import", dingtalk_auto_sync_enabled=auto_sync),
    )
    counters = {"document_count", "link_count"}
    original = {
        key: value
        for key, value in test_db.get(Kind, kb_id).json["spec"].items()
        if key not in counters
    }

    result = await import_tool(kb_id)

    assert result["action"] == "created"
    assert result["name"] == "Live document"
    assert result["index_status"] == "queued"
    assert result["dingtalk_auto_sync_enabled"] is auto_sync
    document = test_db.get(KnowledgeDocument, result["id"])
    assert document.external_resource_id == "unsynced-node"
    assert dispatched == [document.id]
    assert test_db.query(DingtalkSyncedNode).count() == 0
    assert {
        key: value
        for key, value in test_db.get(Kind, kb_id).json["spec"].items()
        if key not in counters
    } == original
    live_docs.call_tool.assert_awaited_once_with(
        "get_document_info", {"nodeId": "unsynced-node"}
    )


async def test_reimport_preserves_identity_folder_and_source_user(
    test_db: Session,
    test_user: User,
    live_docs: SimpleNamespace,
    import_tool: ImportTool,
    dispatched: list[int],
) -> None:
    kb_id = KnowledgeService.create_knowledge_base(
        test_db, test_user.id, KnowledgeBaseCreate(name="Reimport")
    )
    folder = KnowledgeFolderService.create_folder(
        test_db, kb_id, test_user.id, KnowledgeFolderCreate(name="Original folder")
    )
    first = await import_tool(kb_id, folder_id=folder.id)
    processing = await import_tool(kb_id)
    assert processing["id"] == first["id"]
    assert processing["action"] == "processing"
    assert dispatched == [first["id"]]
    assert live_docs.call_tool.await_count == 1

    # A different authorized manager imports a copy originally owned by this user.
    source_user = User(
        user_name="source-owner",
        password_hash="unused-test-hash",
        email="source@example.test",
        is_active=True,
    )
    test_db.add(source_user)
    test_db.flush()
    document = test_db.get(KnowledgeDocument, first["id"])
    document.user_id = source_user.id
    document.index_status = DocumentIndexStatus.SUCCESS
    test_db.commit()
    live_docs.info["name"] = "Renamed source"

    refreshed = await import_tool(kb_id)

    assert refreshed["id"] == first["id"]
    assert refreshed["action"] == "refreshed"
    assert document.folder_id == folder.id
    assert document.user_id == source_user.id
    assert live_docs.users == [test_user.id, source_user.id]
    assert test_db.query(KnowledgeDocument).count() == 1
    assert dispatched == [first["id"], first["id"]]
    assert test_db.query(DingtalkSyncedNode).count() == 0


async def test_concurrent_imports_reuse_the_unique_copy(
    mcp_test_db: Session,
    live_docs: SimpleNamespace,
    dispatched: list[int],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    user = User(user_name="concurrent-owner", password_hash="unused-test-hash")
    mcp_test_db.add(user)
    mcp_test_db.commit()
    kb_id = KnowledgeService.create_knowledge_base(
        mcp_test_db, user.id, KnowledgeBaseCreate(name="Concurrent import")
    )
    mcp_test_db.commit()
    monkeypatch.setattr(
        knowledge,
        "SessionLocal",
        sessionmaker(bind=mcp_test_db.get_bind(), expire_on_commit=False),
    )
    token = TaskTokenInfo(
        task_id=1, subtask_id=1, user_id=user.id, user_name=user.user_name
    )

    async def invoke() -> dict[str, Any]:
        return await asyncio.to_thread(
            knowledge.import_dingtalk_document, token, kb_id, "unsynced-node"
        )

    started, release = threading.Event(), threading.Event()
    original_call = live_docs.call_tool.side_effect

    async def gated_call(name: str, arguments: dict[str, Any]) -> SimpleNamespace:
        if not started.is_set():
            started.set()
            assert await asyncio.to_thread(release.wait, 5)
        return await original_call(name, arguments)

    live_docs.call_tool.side_effect = gated_call
    pending = asyncio.create_task(invoke())
    try:
        assert await asyncio.to_thread(started.wait, 5), (
            pending.result() if pending.done() else "Metadata request did not start"
        )
        winner = await invoke()
    finally:
        release.set()
        concurrent = await pending

    assert winner["action"] == "created"
    assert concurrent["action"] == "processing"
    assert concurrent["id"] == winner["id"]
    assert dispatched == [winner["id"]]
    assert mcp_test_db.query(KnowledgeDocument).count() == 1


@pytest.mark.parametrize(
    "info",
    [
        {"nodeType": "folder"},
        {"extension": "zip"},
        {"extension": "able"},
        {"extension": "axls"},
        {"name": " "},
        {"success": False, "errorCode": "invalidRequest.resource.notFound"},
        {"success": False, "errorCode": "permissionDenied"},
    ],
)
async def test_invalid_live_metadata_creates_no_placeholder(
    test_db: Session,
    test_user: User,
    live_docs: SimpleNamespace,
    import_tool: ImportTool,
    dispatched: list[int],
    info: dict[str, Any],
) -> None:
    kb_id = KnowledgeService.create_knowledge_base(
        test_db, test_user.id, KnowledgeBaseCreate(name="Rejected metadata")
    )
    live_docs.info.update(info)

    result = await import_tool(kb_id)

    assert result["error"]
    assert test_db.query(KnowledgeDocument).count() == 0
    assert test_db.query(DingtalkSyncedNode).count() == 0
    assert dispatched == []


@pytest.mark.parametrize("node_id", ["", " ", "node/name", "node?query", "x" * 256])
async def test_invalid_node_id_rejected_without_mcp_call(
    test_db: Session,
    test_user: User,
    live_docs: SimpleNamespace,
    import_tool: ImportTool,
    node_id: str,
) -> None:
    kb_id = KnowledgeService.create_knowledge_base(
        test_db, test_user.id, KnowledgeBaseCreate(name="Invalid ID")
    )

    result = await import_tool(kb_id, node_id)

    assert result["error"]
    live_docs.call_tool.assert_not_awaited()
    assert test_db.query(KnowledgeDocument).count() == 0


async def test_permission_denial_precedes_source_read(
    test_db: Session,
    test_user: User,
    live_docs: SimpleNamespace,
    import_tool: ImportTool,
) -> None:
    owner = User(user_name="private-kb-owner", password_hash="unused-test-hash")
    test_db.add(owner)
    test_db.flush()
    kb_id = KnowledgeService.create_knowledge_base(
        test_db, owner.id, KnowledgeBaseCreate(name="Private KB")
    )

    result = await import_tool(kb_id)

    assert result["error"]
    live_docs.call_tool.assert_not_awaited()
    assert test_db.query(KnowledgeDocument).count() == 0


async def test_invalid_folder_precedes_source_read(
    test_db: Session,
    test_user: User,
    live_docs: SimpleNamespace,
    import_tool: ImportTool,
) -> None:
    kb_id = KnowledgeService.create_knowledge_base(
        test_db, test_user.id, KnowledgeBaseCreate(name="Invalid folder")
    )
    other_id = KnowledgeService.create_knowledge_base(
        test_db, test_user.id, KnowledgeBaseCreate(name="Other KB")
    )
    folder = KnowledgeFolderService.create_folder(
        test_db, other_id, test_user.id, KnowledgeFolderCreate(name="Other folder")
    )

    result = await import_tool(kb_id, folder_id=folder.id)

    assert result["error"]
    live_docs.call_tool.assert_not_awaited()
    assert test_db.query(KnowledgeDocument).count() == 0


async def test_transport_failure_is_redacted_and_leaves_no_document(
    test_db: Session,
    test_user: User,
    live_docs: SimpleNamespace,
    import_tool: ImportTool,
    dispatched: list[int],
    caplog: pytest.LogCaptureFixture,
) -> None:
    kb_id = KnowledgeService.create_knowledge_base(
        test_db, test_user.id, KnowledgeBaseCreate(name="Transport failure")
    )
    live_docs.call_tool.side_effect = RuntimeError(
        "https://mcp.example.test/private-key?token=private-token"
    )

    result = await import_tool(kb_id)

    assert result["error"]
    assert "private-key" not in json.dumps(result) + caplog.text
    assert "private-token" not in json.dumps(result) + caplog.text
    assert test_db.query(KnowledgeDocument).count() == 0
    assert dispatched == []


@pytest.mark.parametrize("auth_mode", ["missing", "oauth"])
async def test_unconfigured_or_unauthorized_docs_leaves_no_document(
    test_db: Session,
    test_user: User,
    import_tool: ImportTool,
    dispatched: list[int],
    auth_mode: str,
) -> None:
    if auth_mode == "oauth":
        from app.services.user_mcp_service import user_mcp_service

        preferences = user_mcp_service.set_provider_service_config(
            test_user.preferences,
            provider_id="dingtalk",
            service_id="docs",
            enabled=True,
            url="https://mcp.example.test/docs",
            auth_mode="oauth",
        )
        test_user.preferences = user_mcp_service.dump_preferences(preferences)
        test_db.commit()
    kb_id = KnowledgeService.create_knowledge_base(
        test_db, test_user.id, KnowledgeBaseCreate(name="Missing authorization")
    )

    result = await import_tool(kb_id)

    assert result["error"]
    assert test_db.query(KnowledgeDocument).count() == 0
    assert dispatched == []


async def test_real_mcp_registration_exposes_only_node_import_parameters() -> None:
    from app.mcp_server.server import (
        ensure_knowledge_tools_registered,
        knowledge_mcp_server,
    )

    ensure_knowledge_tools_registered()
    tool = next(
        tool
        for tool in await knowledge_mcp_server.list_tools()
        if tool.name == "wegent_kb_import_dingtalk_document"
    )

    assert set(tool.inputSchema["properties"]) == {
        "knowledge_base_id",
        "node_id",
        "folder_id",
    }
    assert set(tool.inputSchema["required"]) == {"knowledge_base_id", "node_id"}
    assert tool.inputSchema["properties"]["folder_id"]["default"] == 0


async def test_daily_refresh_of_unsynced_copy_uses_original_importer(
    test_db: Session,
    test_user: User,
    live_docs: SimpleNamespace,
    import_tool: ImportTool,
    dispatched: list[int],
) -> None:
    from app.services.knowledge.dingtalk_auto_sync import refresh_dingtalk_copy

    kb_id = KnowledgeService.create_knowledge_base(
        test_db,
        test_user.id,
        KnowledgeBaseCreate(name="Daily unsynced", dingtalk_auto_sync_enabled=True),
    )
    created = await import_tool(kb_id)
    document = test_db.get(KnowledgeDocument, created["id"])
    document.index_status = DocumentIndexStatus.SUCCESS
    test_db.commit()

    queued = await asyncio.to_thread(
        refresh_dingtalk_copy, test_db, document.id, document.index_generation
    )

    assert queued is True
    assert dispatched == [document.id, document.id]
    assert live_docs.users == [test_user.id, test_user.id]
    assert test_db.query(DingtalkSyncedNode).count() == 0


async def test_inactive_original_importer_cannot_be_replaced_by_caller(
    test_db: Session,
    test_user: User,
    live_docs: SimpleNamespace,
    import_tool: ImportTool,
    dispatched: list[int],
) -> None:
    kb_id = KnowledgeService.create_knowledge_base(
        test_db, test_user.id, KnowledgeBaseCreate(name="Unavailable importer")
    )
    created = await import_tool(kb_id)
    original = User(
        user_name="inactive-importer", password_hash="unused-test-hash", is_active=False
    )
    test_db.add(original)
    test_db.flush()
    document = test_db.get(KnowledgeDocument, created["id"])
    document.user_id = original.id
    document.index_status = DocumentIndexStatus.SUCCESS
    test_db.commit()

    result = await import_tool(kb_id)

    assert result["error"] == "The original importer is unavailable"
    assert live_docs.users == [test_user.id]
    assert dispatched == [document.id]
    assert document.user_id == original.id
    assert document.index_status == DocumentIndexStatus.SUCCESS
