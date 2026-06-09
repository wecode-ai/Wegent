# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for external knowledge MCP tools."""

import json
from datetime import datetime, timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.core.rate_limit import ExternalMcpRateLimitStatus
from app.mcp_server import server as mcp_server_module
from app.mcp_server.tools import knowledge_external
from app.models.knowledge import DocumentIndexStatus, KnowledgeDocument, KnowledgeFolder
from app.models.subtask_context import ContextType, SubtaskContext
from app.schemas.knowledge import ResourceScope
from app.services.knowledge import external_nodes
from app.services.knowledge.external_document_access import DOWNLOAD_TOKEN_HEADER


def _set_external_user(user):
    token = mcp_server_module._external_knowledge_request_user.set(user)
    return token


def _reset_external_user(token) -> None:
    mcp_server_module._external_knowledge_request_user.reset(token)


@pytest.fixture(autouse=True)
def allow_external_search_rate_limit():
    runtime_spec = MagicMock()
    with (
        patch.object(
            knowledge_external,
            "_search_rate_limit_status",
            return_value=ExternalMcpRateLimitStatus.ALLOWED,
        ),
        patch.object(
            knowledge_external.RagRuntimeResolver,
            "build_query_knowledge_base_configs_from_records",
            return_value=["resolved-config"],
        ),
        patch.object(
            knowledge_external.RagRuntimeResolver,
            "build_query_runtime_spec",
            return_value=runtime_spec,
        ),
    ):
        yield


def _make_kb(kb_id: int, user_id: int, name: str, created_at: datetime):
    return SimpleNamespace(
        id=kb_id,
        user_id=user_id,
        namespace="default",
        json={"spec": {"name": name, "description": f"{name} description"}},
        created_at=created_at,
        updated_at=created_at,
    )


def _make_attachment(
    user_id: int,
    *,
    name: str = "document.pdf",
    mime_type: str = "application/pdf",
    file_extension: str = ".pdf",
    file_size: int = 123,
    storage_key: str = "attachments/document.pdf",
    extracted_text: str = "parsed content",
):
    return SubtaskContext(
        subtask_id=0,
        user_id=user_id,
        context_type=ContextType.ATTACHMENT.value,
        name=name,
        status="ready",
        binary_data=b"",
        image_base64="",
        extracted_text=extracted_text,
        text_length=len(extracted_text),
        type_data={
            "original_filename": name,
            "file_extension": file_extension,
            "file_size": file_size,
            "mime_type": mime_type,
            "storage_backend": "mysql",
            "storage_key": storage_key,
        },
    )


@pytest.mark.asyncio
async def test_list_knowledge_bases_rejects_missing_group_name(test_user):
    token = _set_external_user(test_user)
    try:
        result = await knowledge_external.wegent_kb_list_knowledge_bases(
            scope=ResourceScope.GROUP.value,
            group_name="  ",
        )
    finally:
        _reset_external_user(token)

    assert json.loads(result) == {
        "error": "group_name is required when scope is group",
        "code": "bad_request",
    }


@pytest.mark.asyncio
async def test_list_knowledge_bases_rejects_invalid_input_types(test_user):
    token = _set_external_user(test_user)
    try:
        invalid_scope = await knowledge_external.wegent_kb_list_knowledge_bases(
            scope=1,
        )
        invalid_group_name = await knowledge_external.wegent_kb_list_knowledge_bases(
            group_name=1,
        )
        invalid_query = await knowledge_external.wegent_kb_list_knowledge_bases(
            query=1,
        )
        invalid_limit = await knowledge_external.wegent_kb_list_knowledge_bases(
            limit=knowledge_external.MAX_KNOWLEDGE_BASE_LIST_LIMIT + 1,
        )
        invalid_offset = await knowledge_external.wegent_kb_list_knowledge_bases(
            offset=-1,
        )
    finally:
        _reset_external_user(token)

    assert json.loads(invalid_scope) == {
        "error": "scope must be a string",
        "code": "bad_request",
    }
    assert json.loads(invalid_group_name) == {
        "error": "group_name must be a string",
        "code": "bad_request",
    }
    assert json.loads(invalid_query) == {
        "error": "query must be a string",
        "code": "bad_request",
    }
    assert json.loads(invalid_limit) == {
        "error": f"limit must be between 1 and {knowledge_external.MAX_KNOWLEDGE_BASE_LIST_LIMIT}",
        "code": "bad_request",
    }
    assert json.loads(invalid_offset) == {
        "error": "offset must be greater than or equal to 0",
        "code": "bad_request",
    }


@pytest.mark.asyncio
async def test_list_knowledge_bases_sorts_by_created_at_and_normalizes_group_name(
    test_user,
):
    older = _make_kb(1, test_user.id, "Older", datetime(2026, 1, 1, 8, 0, 0))
    newer = _make_kb(2, test_user.id, "Newer", datetime(2026, 1, 2, 8, 0, 0))

    token = _set_external_user(test_user)
    try:
        with (
            patch.object(knowledge_external, "SessionLocal") as session_local,
            patch.object(
                knowledge_external.KnowledgeService,
                "list_knowledge_bases",
                return_value=[older, newer],
            ) as list_kbs,
            patch.object(
                knowledge_external,
                "get_document_counts",
                return_value={1: 2, 2: 1},
            ),
        ):
            mock_db = MagicMock()
            session_local.return_value = mock_db

            result = await knowledge_external.wegent_kb_list_knowledge_bases(
                scope=ResourceScope.GROUP.value,
                group_name=" team-a ",
            )
    finally:
        _reset_external_user(token)

    payload = json.loads(result)
    assert [item["knowledge_base_id"] for item in payload["items"]] == [2, 1]
    assert payload["total"] == 2
    assert payload["total_returned"] == 2
    assert payload["has_more"] is False
    assert payload["limit"] == knowledge_external.DEFAULT_KNOWLEDGE_BASE_LIST_LIMIT
    assert payload["offset"] == 0
    assert payload["items"][0]["document_count"] == 1
    list_kbs.assert_called_once_with(
        mock_db,
        test_user.id,
        scope=ResourceScope.GROUP,
        group_name="team-a",
    )


@pytest.mark.asyncio
async def test_list_knowledge_bases_paginates_before_counting_documents(test_user):
    older = _make_kb(1, test_user.id, "Older", datetime(2026, 1, 1, 8, 0, 0))
    middle = _make_kb(2, test_user.id, "Middle", datetime(2026, 1, 2, 8, 0, 0))
    newer = _make_kb(3, test_user.id, "Newer", datetime(2026, 1, 3, 8, 0, 0))

    token = _set_external_user(test_user)
    try:
        with (
            patch.object(knowledge_external, "SessionLocal") as session_local,
            patch.object(
                knowledge_external.KnowledgeService,
                "list_knowledge_bases",
                return_value=[older, middle, newer],
            ),
            patch.object(
                knowledge_external,
                "get_document_counts",
                return_value={2: 5},
            ) as get_counts,
        ):
            mock_db = MagicMock()
            session_local.return_value = mock_db

            result = await knowledge_external.wegent_kb_list_knowledge_bases(
                limit=1,
                offset=1,
            )
    finally:
        _reset_external_user(token)

    payload = json.loads(result)
    assert payload["total"] == 3
    assert payload["total_returned"] == 1
    assert payload["has_more"] is True
    assert payload["limit"] == 1
    assert payload["offset"] == 1
    assert [item["knowledge_base_id"] for item in payload["items"]] == [2]
    assert payload["items"][0]["document_count"] == 5
    get_counts.assert_called_once_with(mock_db, [2])


@pytest.mark.asyncio
async def test_list_knowledge_bases_counts_all_documents(test_db, test_user):
    now = datetime(2026, 1, 2, 9, 0, 0)
    kb = _make_kb(3, test_user.id, "KB", now)
    active_doc = KnowledgeDocument(
        kind_id=3,
        attachment_id=0,
        name="active.md",
        file_extension="md",
        file_size=10,
        user_id=test_user.id,
        is_active=True,
        index_status=DocumentIndexStatus.SUCCESS,
        source_type="file",
        folder_id=0,
        created_at=now,
        updated_at=now,
    )
    inactive_doc = KnowledgeDocument(
        kind_id=3,
        attachment_id=0,
        name="queued.md",
        file_extension="md",
        file_size=10,
        user_id=test_user.id,
        is_active=False,
        index_status=DocumentIndexStatus.QUEUED,
        source_type="file",
        folder_id=0,
        created_at=now,
        updated_at=now,
    )
    test_db.add_all([active_doc, inactive_doc])
    test_db.commit()

    token = _set_external_user(test_user)
    try:
        with (
            patch.object(knowledge_external, "SessionLocal", return_value=test_db),
            patch.object(
                knowledge_external.KnowledgeService,
                "list_knowledge_bases",
                return_value=[kb],
            ),
        ):
            result = await knowledge_external.wegent_kb_list_knowledge_bases()
    finally:
        _reset_external_user(token)

    payload = json.loads(result)
    assert payload["items"][0]["document_count"] == 2


@pytest.mark.asyncio
async def test_list_nodes_recursive_counts_nested_nodes_and_sorts(test_db, test_user):
    now = datetime(2026, 1, 3, 8, 0, 0)
    root_folder = KnowledgeFolder(
        kind_id=10,
        parent_id=0,
        name="Root folder",
        created_at=now - timedelta(hours=1),
        updated_at=now,
    )
    child_folder = KnowledgeFolder(
        kind_id=10,
        parent_id=0,
        name="Child folder",
        created_at=now,
        updated_at=now,
    )
    test_db.add_all([root_folder, child_folder])
    test_db.flush()

    child_doc = KnowledgeDocument(
        kind_id=10,
        attachment_id=0,
        name="child.md",
        file_extension="md",
        file_size=10,
        user_id=test_user.id,
        is_active=True,
        index_status=DocumentIndexStatus.SUCCESS,
        source_type="file",
        folder_id=child_folder.id,
        created_at=now,
        updated_at=now,
    )
    root_doc = KnowledgeDocument(
        kind_id=10,
        attachment_id=0,
        name="root.md",
        file_extension="md",
        file_size=10,
        user_id=test_user.id,
        is_active=True,
        index_status=DocumentIndexStatus.SUCCESS,
        source_type="file",
        folder_id=0,
        created_at=now + timedelta(hours=1),
        updated_at=now,
    )
    test_db.add_all([child_doc, root_doc])
    test_db.commit()

    kb = _make_kb(10, test_user.id, "KB", now)
    token = _set_external_user(test_user)
    try:
        with (
            patch.object(knowledge_external, "SessionLocal", return_value=test_db),
            patch.object(
                knowledge_external.KnowledgeService,
                "get_knowledge_base",
                return_value=(kb, True),
            ),
        ):
            result = await knowledge_external.wegent_kb_list_nodes(
                knowledge_base_id=10,
                recursive=True,
            )
    finally:
        _reset_external_user(token)

    payload = json.loads(result)
    assert payload["total_returned"] == 4
    assert [item["node_id"] for item in payload["items"]] == [
        f"folder:{child_folder.id}",
        f"folder:{root_folder.id}",
        f"document:{root_doc.id}",
    ]
    assert payload["items"][0]["children"][0]["node_id"] == f"document:{child_doc.id}"


@pytest.mark.asyncio
async def test_list_nodes_recursive_rejects_large_root_before_loading_tree(
    test_db,
    test_user,
    monkeypatch,
):
    now = datetime(2026, 1, 3, 8, 30, 0)
    documents = [
        KnowledgeDocument(
            kind_id=14,
            attachment_id=0,
            name=f"doc-{index}.md",
            file_extension="md",
            file_size=10,
            user_id=test_user.id,
            is_active=True,
            index_status=DocumentIndexStatus.SUCCESS,
            source_type="file",
            folder_id=0,
            created_at=now + timedelta(minutes=index),
            updated_at=now,
        )
        for index in range(3)
    ]
    test_db.add_all(documents)
    test_db.commit()

    monkeypatch.setattr(external_nodes, "MAX_RECURSIVE_NODES", 2)
    kb = _make_kb(14, test_user.id, "KB", now)
    token = _set_external_user(test_user)
    try:
        with (
            patch.object(knowledge_external, "SessionLocal", return_value=test_db),
            patch.object(
                knowledge_external.KnowledgeService,
                "get_knowledge_base",
                return_value=(kb, True),
            ),
        ):
            result = await knowledge_external.wegent_kb_list_nodes(
                knowledge_base_id=14,
                recursive=True,
            )
    finally:
        _reset_external_user(token)

    payload = json.loads(result)
    assert payload["code"] == "result_too_large"


@pytest.mark.asyncio
async def test_list_nodes_recursive_folder_scope_ignores_unrelated_nodes(
    test_db,
    test_user,
    monkeypatch,
):
    now = datetime(2026, 1, 3, 8, 45, 0)
    target_folder = KnowledgeFolder(
        kind_id=15,
        parent_id=0,
        name="Target",
        created_at=now,
        updated_at=now,
    )
    test_db.add(target_folder)
    test_db.flush()

    target_doc = KnowledgeDocument(
        kind_id=15,
        attachment_id=0,
        name="target.md",
        file_extension="md",
        file_size=10,
        user_id=test_user.id,
        is_active=True,
        index_status=DocumentIndexStatus.SUCCESS,
        source_type="file",
        folder_id=target_folder.id,
        created_at=now,
        updated_at=now,
    )
    unrelated_docs = [
        KnowledgeDocument(
            kind_id=15,
            attachment_id=0,
            name=f"unrelated-{index}.md",
            file_extension="md",
            file_size=10,
            user_id=test_user.id,
            is_active=True,
            index_status=DocumentIndexStatus.SUCCESS,
            source_type="file",
            folder_id=0,
            created_at=now + timedelta(minutes=index + 1),
            updated_at=now,
        )
        for index in range(3)
    ]
    test_db.add_all([target_doc, *unrelated_docs])
    test_db.commit()

    monkeypatch.setattr(external_nodes, "MAX_RECURSIVE_NODES", 2)
    kb = _make_kb(15, test_user.id, "KB", now)
    token = _set_external_user(test_user)
    try:
        with (
            patch.object(knowledge_external, "SessionLocal", return_value=test_db),
            patch.object(
                knowledge_external.KnowledgeService,
                "get_knowledge_base",
                return_value=(kb, True),
            ),
        ):
            result = await knowledge_external.wegent_kb_list_nodes(
                knowledge_base_id=15,
                folder_id=target_folder.id,
                recursive=True,
            )
    finally:
        _reset_external_user(token)

    payload = json.loads(result)
    assert payload["total_returned"] == 1
    assert payload["items"][0]["node_id"] == f"document:{target_doc.id}"


@pytest.mark.asyncio
async def test_list_nodes_recursive_folder_scope_returns_nested_subtree(
    test_db,
    test_user,
):
    now = datetime(2026, 1, 3, 8, 50, 0)
    parent_folder = KnowledgeFolder(
        kind_id=17,
        parent_id=0,
        name="Parent",
        created_at=now,
        updated_at=now,
    )
    test_db.add(parent_folder)
    test_db.flush()
    child_folder = KnowledgeFolder(
        kind_id=17,
        parent_id=parent_folder.id,
        name="Child",
        created_at=now + timedelta(minutes=1),
        updated_at=now,
    )
    test_db.add(child_folder)
    test_db.flush()
    nested_doc = KnowledgeDocument(
        kind_id=17,
        attachment_id=0,
        name="nested.md",
        file_extension="md",
        file_size=10,
        user_id=test_user.id,
        is_active=True,
        index_status=DocumentIndexStatus.SUCCESS,
        source_type="file",
        folder_id=child_folder.id,
        created_at=now + timedelta(minutes=2),
        updated_at=now,
    )
    test_db.add(nested_doc)
    test_db.commit()

    kb = _make_kb(17, test_user.id, "KB", now)
    token = _set_external_user(test_user)
    try:
        with (
            patch.object(knowledge_external, "SessionLocal", return_value=test_db),
            patch.object(
                knowledge_external.KnowledgeService,
                "get_knowledge_base",
                return_value=(kb, True),
            ),
        ):
            result = await knowledge_external.wegent_kb_list_nodes(
                knowledge_base_id=17,
                folder_id=parent_folder.id,
                recursive=True,
            )
    finally:
        _reset_external_user(token)

    payload = json.loads(result)
    assert payload["total_returned"] == 2
    assert payload["items"][0]["node_id"] == f"folder:{child_folder.id}"
    assert payload["items"][0]["children"][0]["node_id"] == f"document:{nested_doc.id}"


@pytest.mark.asyncio
async def test_list_nodes_includes_inactive_documents_by_default(test_db, test_user):
    now = datetime(2026, 1, 3, 9, 0, 0)
    inactive_doc = KnowledgeDocument(
        kind_id=12,
        attachment_id=0,
        name="queued.md",
        file_extension="md",
        file_size=10,
        user_id=test_user.id,
        is_active=False,
        index_status=DocumentIndexStatus.QUEUED,
        source_type="file",
        folder_id=0,
        created_at=now,
        updated_at=now,
    )
    test_db.add(inactive_doc)
    test_db.commit()

    kb = _make_kb(12, test_user.id, "KB", now)
    token = _set_external_user(test_user)
    try:
        with (
            patch.object(knowledge_external, "SessionLocal", return_value=test_db),
            patch.object(
                knowledge_external.KnowledgeService,
                "get_knowledge_base",
                return_value=(kb, True),
            ),
        ):
            result = await knowledge_external.wegent_kb_list_nodes(knowledge_base_id=12)
    finally:
        _reset_external_user(token)

    payload = json.loads(result)
    assert payload["total_returned"] == 1
    assert payload["items"][0]["node_id"] == f"document:{inactive_doc.id}"
    assert payload["items"][0]["index_status"] == DocumentIndexStatus.QUEUED.value


@pytest.mark.asyncio
async def test_list_nodes_returns_document_capability_metadata(test_db, test_user):
    now = datetime(2026, 1, 3, 9, 30, 0)
    readable_attachment = _make_attachment(
        test_user.id,
        name="readable.pdf",
        mime_type="application/pdf",
        file_extension=".pdf",
        storage_key="attachments/readable.pdf",
        extracted_text="readable text",
    )
    office_attachment = _make_attachment(
        test_user.id,
        name="sheet.xlsx",
        mime_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        file_extension=".xlsx",
        storage_key="attachments/sheet.xlsx",
        extracted_text="sheet text",
    )
    empty_attachment = _make_attachment(
        test_user.id,
        name="empty.txt",
        mime_type="text/plain",
        file_extension=".txt",
        storage_key="",
        extracted_text="",
    )
    test_db.add_all([readable_attachment, office_attachment, empty_attachment])
    test_db.flush()

    docs = [
        KnowledgeDocument(
            kind_id=18,
            attachment_id=readable_attachment.id,
            name="readable.pdf",
            file_extension="pdf",
            file_size=123,
            user_id=test_user.id,
            is_active=True,
            index_status=DocumentIndexStatus.SUCCESS,
            source_type="file",
            folder_id=0,
            created_at=now + timedelta(minutes=3),
            updated_at=now,
        ),
        KnowledgeDocument(
            kind_id=18,
            attachment_id=office_attachment.id,
            name="sheet.xlsx",
            file_extension="xlsx",
            file_size=456,
            user_id=test_user.id,
            is_active=True,
            index_status=DocumentIndexStatus.SUCCESS,
            source_type="file",
            folder_id=0,
            created_at=now + timedelta(minutes=2),
            updated_at=now,
        ),
        KnowledgeDocument(
            kind_id=18,
            attachment_id=empty_attachment.id,
            name="empty.txt",
            file_extension="txt",
            file_size=10,
            user_id=test_user.id,
            is_active=True,
            index_status=DocumentIndexStatus.SUCCESS,
            source_type="file",
            folder_id=0,
            created_at=now + timedelta(minutes=1),
            updated_at=now,
        ),
    ]
    folder = KnowledgeFolder(
        kind_id=18,
        parent_id=0,
        name="Folder",
        created_at=now + timedelta(minutes=4),
        updated_at=now,
    )
    test_db.add_all([folder, *docs])
    test_db.commit()

    kb = _make_kb(18, test_user.id, "KB", now)
    token = _set_external_user(test_user)
    try:
        with (
            patch.object(knowledge_external, "SessionLocal", return_value=test_db),
            patch.object(
                knowledge_external.KnowledgeService,
                "get_knowledge_base",
                return_value=(kb, True),
            ),
        ):
            result = await knowledge_external.wegent_kb_list_nodes(
                knowledge_base_id=18,
                limit=4,
            )
    finally:
        _reset_external_user(token)

    payload = json.loads(result)
    nodes_by_name = {item["name"]: item for item in payload["items"]}
    assert nodes_by_name["Folder"]["content_readable"] is False
    assert nodes_by_name["Folder"]["downloadable"] is False
    assert nodes_by_name["Folder"]["previewable"] is False
    assert nodes_by_name["readable.pdf"]["content_readable"] is True
    assert nodes_by_name["readable.pdf"]["downloadable"] is True
    assert nodes_by_name["readable.pdf"]["previewable"] is True
    assert nodes_by_name["readable.pdf"]["mime_type"] == "application/pdf"
    assert nodes_by_name["readable.pdf"]["file_size"] == 123
    assert nodes_by_name["sheet.xlsx"]["content_readable"] is True
    assert nodes_by_name["sheet.xlsx"]["downloadable"] is True
    assert nodes_by_name["sheet.xlsx"]["previewable"] is False
    assert nodes_by_name["empty.txt"]["content_readable"] is False
    assert nodes_by_name["empty.txt"]["downloadable"] is False
    assert nodes_by_name["empty.txt"]["previewable"] is False


@pytest.mark.asyncio
async def test_list_nodes_can_filter_inactive_documents(test_db, test_user):
    now = datetime(2026, 1, 3, 10, 0, 0)
    inactive_doc = KnowledgeDocument(
        kind_id=13,
        attachment_id=0,
        name="queued.md",
        file_extension="md",
        file_size=10,
        user_id=test_user.id,
        is_active=False,
        index_status=DocumentIndexStatus.QUEUED,
        source_type="file",
        folder_id=0,
        created_at=now,
        updated_at=now,
    )
    test_db.add(inactive_doc)
    test_db.commit()

    kb = _make_kb(13, test_user.id, "KB", now)
    token = _set_external_user(test_user)
    try:
        with (
            patch.object(knowledge_external, "SessionLocal", return_value=test_db),
            patch.object(
                knowledge_external.KnowledgeService,
                "get_knowledge_base",
                return_value=(kb, True),
            ),
        ):
            result = await knowledge_external.wegent_kb_list_nodes(
                knowledge_base_id=13,
                include_inactive=False,
            )
    finally:
        _reset_external_user(token)

    payload = json.loads(result)
    assert payload["total_returned"] == 0
    assert payload["items"] == []


@pytest.mark.asyncio
async def test_list_nodes_direct_paginates_folders_before_documents(test_db, test_user):
    now = datetime(2026, 1, 3, 11, 0, 0)
    folders = [
        KnowledgeFolder(
            kind_id=16,
            parent_id=0,
            name=f"folder-{index}",
            created_at=now + timedelta(minutes=index),
            updated_at=now,
        )
        for index in range(2)
    ]
    documents = [
        KnowledgeDocument(
            kind_id=16,
            attachment_id=0,
            name=f"doc-{index}.md",
            file_extension="md",
            file_size=10,
            user_id=test_user.id,
            is_active=True,
            index_status=DocumentIndexStatus.SUCCESS,
            source_type="file",
            folder_id=0,
            created_at=now + timedelta(minutes=index + 10),
            updated_at=now,
        )
        for index in range(2)
    ]
    test_db.add_all([*folders, *documents])
    test_db.commit()

    kb = _make_kb(16, test_user.id, "KB", now)
    token = _set_external_user(test_user)
    try:
        with (
            patch.object(knowledge_external, "SessionLocal", return_value=test_db),
            patch.object(
                knowledge_external.KnowledgeService,
                "get_knowledge_base",
                return_value=(kb, True),
            ),
        ):
            result = await knowledge_external.wegent_kb_list_nodes(
                knowledge_base_id=16,
                limit=2,
                offset=1,
            )
    finally:
        _reset_external_user(token)

    payload = json.loads(result)
    assert payload["total_available"] == 4
    assert payload["total_returned"] == 2
    assert payload["has_more"] is True
    assert [item["node_id"] for item in payload["items"]] == [
        f"folder:{folders[0].id}",
        f"document:{documents[1].id}",
    ]


@pytest.mark.asyncio
async def test_list_nodes_rejects_invalid_limit_and_bool_values(test_user):
    token = _set_external_user(test_user)
    try:
        invalid_recursive = await knowledge_external.wegent_kb_list_nodes(
            knowledge_base_id=1,
            recursive="false",
        )
        invalid_include_inactive = await knowledge_external.wegent_kb_list_nodes(
            knowledge_base_id=1,
            include_inactive=1,
        )
        invalid_limit = await knowledge_external.wegent_kb_list_nodes(
            knowledge_base_id=1,
            limit=knowledge_external.MAX_DIRECT_NODE_LIMIT + 1,
        )
    finally:
        _reset_external_user(token)

    assert json.loads(invalid_recursive) == {
        "error": "recursive must be a boolean",
        "code": "bad_request",
    }
    assert json.loads(invalid_include_inactive) == {
        "error": "include_inactive must be a boolean",
        "code": "bad_request",
    }
    assert json.loads(invalid_limit) == {
        "error": f"limit must be between 1 and {knowledge_external.MAX_DIRECT_NODE_LIMIT}",
        "code": "bad_request",
    }


@pytest.mark.asyncio
async def test_get_document_content_returns_parsed_text_payload(test_db, test_user):
    now = datetime(2026, 1, 3, 12, 0, 0)
    attachment = _make_attachment(
        test_user.id,
        name="doc.md",
        mime_type="text/markdown",
        file_extension=".md",
        extracted_text="hello external knowledge",
    )
    test_db.add(attachment)
    test_db.flush()
    document = KnowledgeDocument(
        kind_id=21,
        attachment_id=attachment.id,
        name="doc.md",
        file_extension="md",
        file_size=23,
        user_id=test_user.id,
        is_active=True,
        index_status=DocumentIndexStatus.SUCCESS,
        source_type="file",
        folder_id=0,
        created_at=now,
        updated_at=now,
    )
    test_db.add(document)
    test_db.commit()

    kb = _make_kb(21, test_user.id, "KB", now)
    token = _set_external_user(test_user)
    try:
        with (
            patch.object(knowledge_external, "SessionLocal", return_value=test_db),
            patch.object(
                knowledge_external.KnowledgeService,
                "get_knowledge_base",
                return_value=(kb, True),
            ),
        ):
            result = await knowledge_external.wegent_kb_get_document_content(
                document_id=document.id,
                offset=6,
                limit=8,
            )
    finally:
        _reset_external_user(token)

    payload = json.loads(result)
    assert payload["document_id"] == document.id
    assert payload["node_id"] == f"document:{document.id}"
    assert payload["knowledge_base_id"] == 21
    assert payload["content"] == "external"
    assert payload["content_format"] == "text"
    assert payload["content_source"] == "parsed_attachment"
    assert payload["content_available"] is True
    assert payload["offset"] == 6
    assert payload["returned_length"] == 8
    assert payload["total_length"] == len("hello external knowledge")
    assert payload["has_more"] is True
    assert payload["index_status"] == DocumentIndexStatus.SUCCESS.value


@pytest.mark.asyncio
async def test_get_document_content_returns_empty_payload_when_text_unavailable(
    test_db,
    test_user,
):
    now = datetime(2026, 1, 3, 12, 30, 0)
    attachment = _make_attachment(
        test_user.id,
        name="image.png",
        mime_type="image/png",
        file_extension=".png",
        extracted_text="",
    )
    test_db.add(attachment)
    test_db.flush()
    document = KnowledgeDocument(
        kind_id=22,
        attachment_id=attachment.id,
        name="image.png",
        file_extension="png",
        file_size=23,
        user_id=test_user.id,
        is_active=True,
        index_status=DocumentIndexStatus.SUCCESS,
        source_type="file",
        folder_id=0,
        created_at=now,
        updated_at=now,
    )
    test_db.add(document)
    test_db.commit()

    kb = _make_kb(22, test_user.id, "KB", now)
    token = _set_external_user(test_user)
    try:
        with (
            patch.object(knowledge_external, "SessionLocal", return_value=test_db),
            patch.object(
                knowledge_external.KnowledgeService,
                "get_knowledge_base",
                return_value=(kb, True),
            ),
        ):
            result = await knowledge_external.wegent_kb_get_document_content(
                document_id=document.id,
            )
    finally:
        _reset_external_user(token)

    payload = json.loads(result)
    assert payload["content"] == ""
    assert payload["content_available"] is False
    assert payload["total_length"] == 0
    assert payload["has_more"] is False


@pytest.mark.asyncio
async def test_get_document_content_ignores_non_attachment_context(
    test_db,
    test_user,
):
    now = datetime(2026, 1, 3, 12, 45, 0)
    context = SubtaskContext(
        subtask_id=0,
        user_id=test_user.id,
        context_type=ContextType.KNOWLEDGE_BASE.value,
        name="kb-context",
        status="ready",
        binary_data=b"",
        image_base64="",
        extracted_text="must not leak",
        text_length=len("must not leak"),
        type_data={},
    )
    test_db.add(context)
    test_db.flush()
    document = KnowledgeDocument(
        kind_id=25,
        attachment_id=context.id,
        name="doc.md",
        file_extension="md",
        file_size=12,
        user_id=test_user.id,
        is_active=True,
        index_status=DocumentIndexStatus.SUCCESS,
        source_type="file",
        folder_id=0,
        created_at=now,
        updated_at=now,
    )
    test_db.add(document)
    test_db.commit()

    kb = _make_kb(25, test_user.id, "KB", now)
    token = _set_external_user(test_user)
    try:
        with (
            patch.object(knowledge_external, "SessionLocal", return_value=test_db),
            patch.object(
                knowledge_external.KnowledgeService,
                "get_knowledge_base",
                return_value=(kb, True),
            ),
        ):
            result = await knowledge_external.wegent_kb_get_document_content(
                document_id=document.id,
            )
    finally:
        _reset_external_user(token)

    payload = json.loads(result)
    assert payload["content"] == ""
    assert payload["content_available"] is False
    assert payload["total_length"] == 0


@pytest.mark.asyncio
async def test_get_document_content_rejects_invalid_arguments(test_user):
    token = _set_external_user(test_user)
    try:
        invalid_document = await knowledge_external.wegent_kb_get_document_content(
            document_id=0,
        )
        invalid_offset = await knowledge_external.wegent_kb_get_document_content(
            document_id=1,
            offset=-1,
        )
        invalid_limit = await knowledge_external.wegent_kb_get_document_content(
            document_id=1,
            limit=knowledge_external.MAX_DOCUMENT_READ_LIMIT + 1,
        )
    finally:
        _reset_external_user(token)

    assert json.loads(invalid_document) == {
        "error": "document_id must be a positive integer",
        "code": "bad_request",
    }
    assert json.loads(invalid_offset) == {
        "error": "offset must be greater than or equal to 0",
        "code": "bad_request",
    }
    assert json.loads(invalid_limit) == {
        "error": f"limit must be between 1 and {knowledge_external.MAX_DOCUMENT_READ_LIMIT}",
        "code": "bad_request",
    }


def test_document_file_url_uses_configured_api_prefix(monkeypatch):
    monkeypatch.setattr(knowledge_external.settings, "API_PREFIX", "/api")
    assert (
        knowledge_external._external_knowledge_document_file_url(123)
        == "/api/mcp/knowledge-external/documents/123/file"
    )

    monkeypatch.setattr(knowledge_external.settings, "API_PREFIX", "")
    assert (
        knowledge_external._external_knowledge_document_file_url(123)
        == "/mcp/knowledge-external/documents/123/file"
    )


def test_document_file_url_prefers_request_mount_path():
    token = mcp_server_module._external_knowledge_request_mount_path.set(
        "/custom/mcp/knowledge-external"
    )
    try:
        assert (
            knowledge_external._external_knowledge_document_file_url(123)
            == "/custom/mcp/knowledge-external/documents/123/file"
        )
    finally:
        mcp_server_module._external_knowledge_request_mount_path.reset(token)


@pytest.mark.asyncio
async def test_get_document_download_returns_short_lived_header_token(
    test_db,
    test_user,
):
    now = datetime(2026, 1, 3, 13, 0, 0)
    attachment = _make_attachment(
        test_user.id,
        name="report.pdf",
        mime_type="application/pdf",
        file_extension=".pdf",
        file_size=321,
        storage_key="attachments/report.pdf",
        extracted_text="report",
    )
    test_db.add(attachment)
    test_db.flush()
    document = KnowledgeDocument(
        kind_id=23,
        attachment_id=attachment.id,
        name="report.pdf",
        file_extension="pdf",
        file_size=321,
        user_id=test_user.id,
        is_active=True,
        index_status=DocumentIndexStatus.SUCCESS,
        source_type="file",
        folder_id=0,
        created_at=now,
        updated_at=now,
    )
    test_db.add(document)
    test_db.commit()

    kb = _make_kb(23, test_user.id, "KB", now)
    token = _set_external_user(test_user)
    try:
        with (
            patch.object(knowledge_external, "SessionLocal", return_value=test_db),
            patch.object(
                knowledge_external.KnowledgeService,
                "get_knowledge_base",
                return_value=(kb, True),
            ),
        ):
            result = await knowledge_external.wegent_kb_get_document_download(
                document_id=document.id,
                disposition="inline",
            )
    finally:
        _reset_external_user(token)

    payload = json.loads(result)
    assert payload["document_id"] == document.id
    assert payload["node_id"] == f"document:{document.id}"
    assert payload["resource_url"] == (
        f"/api/mcp/knowledge-external/documents/{document.id}/file"
    )
    assert set(payload["headers"]) == {DOWNLOAD_TOKEN_HEADER}
    assert payload["expiration_seconds"] == 300
    assert payload["disposition"] == "inline"
    assert payload["mime_type"] == "application/pdf"
    assert payload["file_name"] == "report.pdf"
    assert payload["file_extension"] == "pdf"
    assert payload["file_size"] == 321
    assert payload["downloadable"] is True
    assert payload["previewable"] is True


@pytest.mark.asyncio
async def test_get_document_download_rejects_inline_for_non_previewable_file(
    test_db,
    test_user,
):
    now = datetime(2026, 1, 3, 13, 30, 0)
    attachment = _make_attachment(
        test_user.id,
        name="sheet.xlsx",
        mime_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        file_extension=".xlsx",
        storage_key="attachments/sheet.xlsx",
        extracted_text="sheet",
    )
    test_db.add(attachment)
    test_db.flush()
    document = KnowledgeDocument(
        kind_id=24,
        attachment_id=attachment.id,
        name="sheet.xlsx",
        file_extension="xlsx",
        file_size=321,
        user_id=test_user.id,
        is_active=True,
        index_status=DocumentIndexStatus.SUCCESS,
        source_type="file",
        folder_id=0,
        created_at=now,
        updated_at=now,
    )
    test_db.add(document)
    test_db.commit()

    kb = _make_kb(24, test_user.id, "KB", now)
    token = _set_external_user(test_user)
    try:
        with (
            patch.object(knowledge_external, "SessionLocal", return_value=test_db),
            patch.object(
                knowledge_external.KnowledgeService,
                "get_knowledge_base",
                return_value=(kb, True),
            ),
        ):
            inline_result = await knowledge_external.wegent_kb_get_document_download(
                document_id=document.id,
                disposition="inline",
            )
            attachment_result = (
                await knowledge_external.wegent_kb_get_document_download(
                    document_id=document.id,
                    disposition="attachment",
                )
            )
    finally:
        _reset_external_user(token)

    assert json.loads(inline_result) == {
        "error": "Document file is not previewable",
        "code": "unsupported_media_type",
    }
    assert json.loads(attachment_result)["downloadable"] is True


@pytest.mark.asyncio
async def test_list_nodes_recursive_attaches_disconnected_cycle_once(
    test_db,
    test_user,
):
    now = datetime(2026, 1, 4, 8, 0, 0)
    folder_a = KnowledgeFolder(
        kind_id=11,
        parent_id=0,
        name="A",
        created_at=now,
        updated_at=now,
    )
    folder_b = KnowledgeFolder(
        kind_id=11,
        parent_id=0,
        name="B",
        created_at=now + timedelta(minutes=1),
        updated_at=now,
    )
    test_db.add_all([folder_a, folder_b])
    test_db.flush()
    folder_a.parent_id = folder_b.id
    folder_b.parent_id = folder_a.id
    test_db.commit()

    kb = _make_kb(11, test_user.id, "KB", now)
    token = _set_external_user(test_user)
    try:
        with (
            patch.object(knowledge_external, "SessionLocal", return_value=test_db),
            patch.object(
                knowledge_external.KnowledgeService,
                "get_knowledge_base",
                return_value=(kb, True),
            ),
        ):
            result = await knowledge_external.wegent_kb_list_nodes(
                knowledge_base_id=11,
                recursive=True,
            )
    finally:
        _reset_external_user(token)

    payload = json.loads(result)
    all_node_ids = []

    def collect(nodes):
        for node in nodes:
            all_node_ids.append(node["node_id"])
            collect(node["children"])

    collect(payload["items"])
    assert len(all_node_ids) == len(set(all_node_ids))
    assert any(item["orphan"] for item in payload["items"])
    assert payload["warnings"]


@pytest.mark.asyncio
async def test_search_content_filters_inaccessible_and_invalid_knowledge_base_ids(
    test_user,
):
    kb = _make_kb(1, test_user.id, "Payments", datetime(2026, 1, 5, 8, 0, 0))
    query_content = AsyncMock(
        return_value={
            "total": 1,
            "total_estimated_tokens": 5,
            "records": [
                {
                    "content": "payment flow",
                    "title": "Payment",
                    "score": 0.9,
                    "knowledge_base_id": 1,
                    "document_id": 9,
                }
            ],
        }
    )

    token = _set_external_user(test_user)
    try:
        with (
            patch.object(knowledge_external, "SessionLocal") as session_local,
            patch.object(
                knowledge_external.KnowledgeService,
                "get_knowledge_base",
                side_effect=[(kb, True), (None, False)],
            ),
            patch.object(knowledge_external, "_query_content", query_content),
        ):
            session_local.return_value = MagicMock()
            result = await knowledge_external.wegent_kb_search_content(
                query=" payment ",
                knowledge_base_ids=[1, 999, -1],
            )
    finally:
        _reset_external_user(token)

    payload = json.loads(result)
    assert payload["searched_knowledge_base_ids"] == [1]
    assert payload["ignored_knowledge_base_ids"] == [999, -1]
    assert payload["warnings"] == [knowledge_external.IGNORED_KNOWLEDGE_BASES_WARNING]
    assert payload["records"][0]["knowledge_base_name"] == "Payments"
    query_content.assert_awaited_once()


@pytest.mark.asyncio
async def test_search_content_rejects_missing_knowledge_base_ids(test_user):
    token = _set_external_user(test_user)
    try:
        with patch.object(knowledge_external, "_query_content") as query_content:
            result = await knowledge_external.wegent_kb_search_content(
                query="payment",
            )
    finally:
        _reset_external_user(token)

    assert json.loads(result) == {
        "error": "knowledge_base_ids is required",
        "code": "bad_request",
    }
    query_content.assert_not_called()


@pytest.mark.asyncio
async def test_search_content_applies_search_rate_limit(test_user):
    token = _set_external_user(test_user)
    try:
        with (
            patch.object(
                knowledge_external,
                "_search_rate_limit_status",
                return_value=ExternalMcpRateLimitStatus.LIMITED,
            ),
            patch.object(knowledge_external, "_query_content") as query_content,
        ):
            result = await knowledge_external.wegent_kb_search_content(
                query="payment",
                knowledge_base_ids=[1],
            )
    finally:
        _reset_external_user(token)

    assert json.loads(result) == {
        "error": "Rate limit exceeded",
        "code": "rate_limited",
    }
    query_content.assert_not_called()


@pytest.mark.asyncio
async def test_search_content_fails_closed_when_rate_limit_unavailable(test_user):
    token = _set_external_user(test_user)
    try:
        with (
            patch.object(
                knowledge_external,
                "_search_rate_limit_status",
                return_value=ExternalMcpRateLimitStatus.UNAVAILABLE,
            ),
            patch.object(knowledge_external, "_query_content") as query_content,
        ):
            result = await knowledge_external.wegent_kb_search_content(
                query="payment",
                knowledge_base_ids=[1],
            )
    finally:
        _reset_external_user(token)

    assert json.loads(result) == {
        "error": "Rate limit service unavailable",
        "code": "rate_limit_unavailable",
    }
    query_content.assert_not_called()


@pytest.mark.asyncio
async def test_search_content_rejects_empty_knowledge_base_ids(test_user):
    token = _set_external_user(test_user)
    try:
        with patch.object(knowledge_external, "_query_content") as query_content:
            result = await knowledge_external.wegent_kb_search_content(
                query="payment",
                knowledge_base_ids=[],
            )
    finally:
        _reset_external_user(token)

    assert json.loads(result) == {
        "error": "knowledge_base_ids must not be empty",
        "code": "bad_request",
    }
    query_content.assert_not_called()


@pytest.mark.asyncio
async def test_search_content_rejects_query_above_length_limit(test_user):
    token = _set_external_user(test_user)
    try:
        with patch.object(knowledge_external, "_query_content") as query_content:
            result = await knowledge_external.wegent_kb_search_content(
                query="x" * (knowledge_external.MAX_SEARCH_QUERY_LENGTH + 1),
                knowledge_base_ids=[1],
            )
    finally:
        _reset_external_user(token)

    assert json.loads(result) == {
        "error": f"query must be at most {knowledge_external.MAX_SEARCH_QUERY_LENGTH} characters",
        "code": "bad_request",
    }
    query_content.assert_not_called()


@pytest.mark.asyncio
async def test_search_content_rejects_too_many_unique_knowledge_base_ids(test_user):
    too_many_ids = list(range(1, knowledge_external.MAX_SEARCH_KNOWLEDGE_BASE_IDS + 2))

    token = _set_external_user(test_user)
    try:
        with (
            patch.object(
                knowledge_external.KnowledgeService,
                "get_knowledge_base",
            ) as get_kb,
            patch.object(knowledge_external, "_query_content") as query_content,
        ):
            result = await knowledge_external.wegent_kb_search_content(
                query="payment",
                knowledge_base_ids=too_many_ids,
            )
    finally:
        _reset_external_user(token)

    assert json.loads(result) == {
        "error": f"knowledge_base_ids must contain at most {knowledge_external.MAX_SEARCH_KNOWLEDGE_BASE_IDS} items",
        "code": "bad_request",
    }
    get_kb.assert_not_called()
    query_content.assert_not_called()


@pytest.mark.asyncio
async def test_search_content_deduplicates_ids_before_enforcing_limit(test_user):
    kb = _make_kb(1, test_user.id, "Payments", datetime(2026, 1, 5, 8, 0, 0))
    query_content = AsyncMock(
        return_value={
            "total": 0,
            "total_estimated_tokens": 0,
            "records": [],
        }
    )

    token = _set_external_user(test_user)
    try:
        with (
            patch.object(knowledge_external, "SessionLocal") as session_local,
            patch.object(
                knowledge_external.KnowledgeService,
                "get_knowledge_base",
                return_value=(kb, True),
            ) as get_kb,
            patch.object(knowledge_external, "_query_content", query_content),
        ):
            session_local.return_value = MagicMock()
            result = await knowledge_external.wegent_kb_search_content(
                query="payment",
                knowledge_base_ids=[1]
                * (knowledge_external.MAX_SEARCH_KNOWLEDGE_BASE_IDS + 1),
            )
    finally:
        _reset_external_user(token)

    payload = json.loads(result)
    assert payload["searched_knowledge_base_ids"] == [1]
    get_kb.assert_called_once()
    query_content.assert_awaited_once()


@pytest.mark.asyncio
async def test_search_content_returns_not_found_when_no_requested_kb_is_accessible(
    test_user,
):
    token = _set_external_user(test_user)
    try:
        with (
            patch.object(knowledge_external, "SessionLocal") as session_local,
            patch.object(
                knowledge_external.KnowledgeService,
                "get_knowledge_base",
                return_value=(None, False),
            ),
            patch.object(knowledge_external, "_query_content") as query_content,
        ):
            session_local.return_value = MagicMock()
            result = await knowledge_external.wegent_kb_search_content(
                query="payment",
                knowledge_base_ids=[999],
            )
    finally:
        _reset_external_user(token)

    assert json.loads(result) == {
        "error": "No accessible knowledge bases found",
        "code": "not_found",
    }
    query_content.assert_not_called()


@pytest.mark.asyncio
async def test_search_content_rejects_non_integer_max_results(test_user):
    token = _set_external_user(test_user)
    try:
        result = await knowledge_external.wegent_kb_search_content(
            query="payment",
            knowledge_base_ids=[1],
            max_results="10",
        )
    finally:
        _reset_external_user(token)

    assert json.loads(result) == {
        "error": "max_results must be an integer",
        "code": "bad_request",
    }


@pytest.mark.asyncio
async def test_search_content_reads_document_id_from_metadata(test_user):
    kb = _make_kb(1, test_user.id, "Payments", datetime(2026, 1, 6, 8, 0, 0))
    query_content = AsyncMock(
        return_value={
            "total": 1,
            "total_estimated_tokens": 5,
            "records": [
                {
                    "content": "payment flow",
                    "title": "Payment",
                    "score": 0.9,
                    "knowledge_base_id": 1,
                    "metadata": {"document_id": 9},
                }
            ],
        }
    )

    token = _set_external_user(test_user)
    try:
        with (
            patch.object(knowledge_external, "SessionLocal") as session_local,
            patch.object(
                knowledge_external.KnowledgeService,
                "get_knowledge_base",
                return_value=(kb, True),
            ),
            patch.object(knowledge_external, "_query_content", query_content),
        ):
            session_local.return_value = MagicMock()
            result = await knowledge_external.wegent_kb_search_content(
                query="payment",
                knowledge_base_ids=[1],
            )
    finally:
        _reset_external_user(token)

    payload = json.loads(result)
    assert payload["records"][0]["document_id"] == 9


@pytest.mark.asyncio
async def test_search_content_reads_document_id_from_numeric_doc_ref(test_user):
    kb = _make_kb(1, test_user.id, "Payments", datetime(2026, 1, 6, 8, 30, 0))
    query_content = AsyncMock(
        return_value={
            "total": 1,
            "total_estimated_tokens": 5,
            "records": [
                {
                    "content": "payment flow",
                    "title": "Payment",
                    "score": 0.9,
                    "knowledge_base_id": 1,
                    "metadata": {"doc_ref": "9"},
                }
            ],
        }
    )

    token = _set_external_user(test_user)
    try:
        with (
            patch.object(knowledge_external, "SessionLocal") as session_local,
            patch.object(
                knowledge_external.KnowledgeService,
                "get_knowledge_base",
                return_value=(kb, True),
            ),
            patch.object(knowledge_external, "_query_content", query_content),
        ):
            session_local.return_value = MagicMock()
            result = await knowledge_external.wegent_kb_search_content(
                query="payment",
                knowledge_base_ids=[1],
            )
    finally:
        _reset_external_user(token)

    payload = json.loads(result)
    assert payload["records"][0]["document_id"] == 9


@pytest.mark.asyncio
async def test_search_content_reads_document_id_from_prefixed_doc_ref(test_user):
    kb = _make_kb(1, test_user.id, "Payments", datetime(2026, 1, 6, 8, 40, 0))
    query_content = AsyncMock(
        return_value={
            "total": 1,
            "total_estimated_tokens": 5,
            "records": [
                {
                    "content": "payment flow",
                    "title": "Payment",
                    "score": 0.9,
                    "knowledge_base_id": 1,
                    "metadata": {"doc_ref": "doc_9"},
                }
            ],
        }
    )

    token = _set_external_user(test_user)
    try:
        with (
            patch.object(knowledge_external, "SessionLocal") as session_local,
            patch.object(
                knowledge_external.KnowledgeService,
                "get_knowledge_base",
                return_value=(kb, True),
            ),
            patch.object(knowledge_external, "_query_content", query_content),
        ):
            session_local.return_value = MagicMock()
            result = await knowledge_external.wegent_kb_search_content(
                query="payment",
                knowledge_base_ids=[1],
            )
    finally:
        _reset_external_user(token)

    payload = json.loads(result)
    assert payload["records"][0]["document_id"] == 9


@pytest.mark.asyncio
async def test_search_content_ignores_non_numeric_doc_ref(test_user):
    kb = _make_kb(1, test_user.id, "Payments", datetime(2026, 1, 6, 8, 45, 0))
    query_content = AsyncMock(
        return_value={
            "total": 1,
            "total_estimated_tokens": 5,
            "records": [
                {
                    "content": "payment flow",
                    "title": "Payment",
                    "score": 0.9,
                    "knowledge_base_id": 1,
                    "metadata": {"doc_ref": "doc_abc"},
                }
            ],
        }
    )

    token = _set_external_user(test_user)
    try:
        with (
            patch.object(knowledge_external, "SessionLocal") as session_local,
            patch.object(
                knowledge_external.KnowledgeService,
                "get_knowledge_base",
                return_value=(kb, True),
            ),
            patch.object(knowledge_external, "_query_content", query_content),
        ):
            session_local.return_value = MagicMock()
            result = await knowledge_external.wegent_kb_search_content(
                query="payment",
                knowledge_base_ids=[1],
            )
    finally:
        _reset_external_user(token)

    payload = json.loads(result)
    assert payload["records"][0]["document_id"] is None


@pytest.mark.asyncio
async def test_search_content_uses_query_gateway_without_remote_local_configs(
    test_user,
):
    kb = _make_kb(1, test_user.id, "Payments", datetime(2026, 1, 6, 8, 0, 0))
    runtime_spec = MagicMock()
    gateway = MagicMock()
    gateway.query = AsyncMock(
        return_value={
            "total": 0,
            "total_estimated_tokens": 0,
            "records": [],
        }
    )

    token = _set_external_user(test_user)
    try:
        with (
            patch.object(knowledge_external, "SessionLocal") as session_local,
            patch.object(
                knowledge_external.KnowledgeService,
                "get_knowledge_base",
                return_value=(kb, True),
            ),
            patch.object(knowledge_external, "get_query_gateway", return_value=gateway),
            patch.object(
                knowledge_external.RagRuntimeResolver,
                "build_query_knowledge_base_configs_from_records",
                return_value=["resolved-config"],
            ) as build_configs,
            patch.object(
                knowledge_external.RagRuntimeResolver,
                "build_query_runtime_spec",
                return_value=runtime_spec,
            ) as build_spec,
        ):
            session_local.return_value = MagicMock()
            result = await knowledge_external.wegent_kb_search_content(
                query="payment",
                knowledge_base_ids=[1],
            )
    finally:
        _reset_external_user(token)

    payload = json.loads(result)
    assert payload["searched_knowledge_base_ids"] == [1]
    build_configs.assert_not_called()
    build_spec.assert_called_once()
    assert "db" not in build_spec.call_args.kwargs
    assert build_spec.call_args.kwargs["route_mode"] == "rag_retrieval"
    assert build_spec.call_args.kwargs["knowledge_base_configs"] == []
    gateway.query.assert_awaited_once_with(runtime_spec, db=None)


def test_query_content_local_sync_builds_missing_local_configs():
    runtime_spec = knowledge_external.QueryRuntimeSpec(
        knowledge_base_ids=[1],
        query="payment",
        max_results=10,
        route_mode="rag_retrieval",
        user_id=7,
        user_name="alice",
        knowledge_base_configs=[],
    )
    db = MagicMock()
    local_gateway = MagicMock()
    local_gateway.query = AsyncMock(return_value={"total": 0, "records": []})

    with (
        patch.object(knowledge_external, "SessionLocal", return_value=db),
        patch.object(
            knowledge_external.RagRuntimeResolver,
            "build_query_knowledge_base_configs",
            return_value=["resolved-config"],
        ) as build_configs,
        patch.object(
            knowledge_external,
            "LocalRagGateway",
            return_value=local_gateway,
        ),
    ):
        result = knowledge_external._query_content_local_sync(runtime_spec)

    assert result == {"total": 0, "records": []}
    build_configs.assert_called_once_with(
        db=db,
        knowledge_base_ids=[1],
        current_user_id=7,
        user_name="alice",
    )
    local_gateway.query.assert_awaited_once()
    local_runtime_spec = local_gateway.query.await_args.args[0]
    assert local_runtime_spec.knowledge_base_configs == ["resolved-config"]
    db.close.assert_called_once()


@pytest.mark.asyncio
async def test_query_content_routes_local_gateway_through_threadpool():
    runtime_spec = MagicMock()
    local_result = {"total": 0, "records": []}
    run_in_threadpool = AsyncMock(return_value=local_result)

    with (
        patch.object(
            knowledge_external,
            "get_query_gateway",
            return_value=knowledge_external.LocalRagGateway(),
        ),
        patch.object(
            knowledge_external,
            "run_in_threadpool",
            run_in_threadpool,
        ),
    ):
        result = await knowledge_external._query_content(runtime_spec)

    assert result == local_result
    run_in_threadpool.assert_awaited_once_with(
        knowledge_external._query_content_local_sync,
        runtime_spec,
    )


@pytest.mark.asyncio
async def test_query_content_falls_back_to_local_threadpool_for_retryable_remote_error():
    runtime_spec = MagicMock()
    fallback_result = {"total": 1, "records": [{"content": "fallback"}]}
    gateway = MagicMock()
    gateway.query = AsyncMock(
        side_effect=knowledge_external.RemoteRagGatewayError(
            "knowledge runtime unavailable",
            retryable=True,
        )
    )
    run_in_threadpool = AsyncMock(return_value=fallback_result)

    with (
        patch.object(knowledge_external, "get_query_gateway", return_value=gateway),
        patch.object(
            knowledge_external,
            "run_in_threadpool",
            run_in_threadpool,
        ),
    ):
        result = await knowledge_external._query_content(runtime_spec)

    assert result == fallback_result
    gateway.query.assert_awaited_once_with(runtime_spec, db=None)
    run_in_threadpool.assert_awaited_once_with(
        knowledge_external._query_content_local_sync,
        runtime_spec,
    )


@pytest.mark.asyncio
async def test_query_content_remote_fallback_builds_local_configs_before_query():
    runtime_spec = knowledge_external.QueryRuntimeSpec(
        knowledge_base_ids=[1],
        query="payment",
        max_results=10,
        route_mode="rag_retrieval",
        user_id=7,
        user_name="alice",
        knowledge_base_configs=[],
    )
    remote_gateway = MagicMock()
    remote_gateway.query = AsyncMock(
        side_effect=knowledge_external.RemoteRagGatewayError(
            "knowledge runtime unavailable",
            status_code=503,
        )
    )
    db = MagicMock()
    local_query = AsyncMock(
        return_value={"total": 1, "records": [{"content": "fallback"}]}
    )

    with (
        patch.object(
            knowledge_external,
            "get_query_gateway",
            return_value=remote_gateway,
        ),
        patch.object(knowledge_external, "SessionLocal", return_value=db),
        patch.object(
            knowledge_external.RagRuntimeResolver,
            "build_query_knowledge_base_configs",
            return_value=["resolved-config"],
        ) as build_configs,
        patch.object(
            knowledge_external.LocalRagGateway,
            "query",
            local_query,
        ),
    ):
        result = await knowledge_external._query_content(runtime_spec)

    assert result == {"total": 1, "records": [{"content": "fallback"}]}
    remote_gateway.query.assert_awaited_once_with(runtime_spec, db=None)
    build_configs.assert_called_once_with(
        db=db,
        knowledge_base_ids=[1],
        current_user_id=7,
        user_name="alice",
    )
    local_query.assert_awaited_once()
    local_runtime_spec = local_query.await_args.args[0]
    assert local_runtime_spec.knowledge_base_configs == ["resolved-config"]
    db.close.assert_called_once()
