# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import asyncio
import threading
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

from app.models.kind import Kind
from app.models.knowledge import KnowledgeDocument
from app.models.task import TaskResource
from app.schemas.knowledge import (
    DocumentSourceType,
    KnowledgeBaseCreate,
    KnowledgeDocumentCreate,
    KnowledgeFolderCreate,
    KnowledgeFolderUpdate,
)
from app.services.context import context_service
from app.services.knowledge import TaskKnowledgeBaseService
from app.services.knowledge.folder_service import KnowledgeFolderService
from app.services.knowledge.knowledge_service import (
    KnowledgeService,
    _run_async_in_new_loop,
)


@pytest.mark.unit
class TestKnowledgeServiceCreateKnowledgeBase:
    def test_create_knowledge_base_persists_retrieval_config_as_dict(
        self, test_db, test_user
    ) -> None:
        """Create schema coercion must not leak Pydantic models into CRD spec."""
        knowledge_base_id = KnowledgeService.create_knowledge_base(
            db=test_db,
            user_id=test_user.id,
            data=KnowledgeBaseCreate(
                name="rag-kb",
                retrieval_config={
                    "retriever_name": "retriever-1",
                    "retriever_namespace": "default",
                    "embedding_config": {
                        "model_name": "embedding-1",
                        "model_namespace": "default",
                    },
                    "retrieval_mode": "vector",
                    "top_k": 5,
                    "score_threshold": 0.5,
                    "hybrid_weights": {
                        "vector_weight": 0.7,
                        "keyword_weight": 0.3,
                    },
                },
            ),
        )

        knowledge_base = test_db.query(Kind).filter(Kind.id == knowledge_base_id).one()
        retrieval_config = knowledge_base.json["spec"]["retrievalConfig"]

        assert isinstance(retrieval_config, dict)
        assert retrieval_config["retriever_name"] == "retriever-1"
        assert retrieval_config["embedding_config"]["model_name"] == "embedding-1"


@pytest.mark.unit
class TestKnowledgeServiceDefaultViewSemantics:
    def test_notebook_default_view_allows_more_than_50_documents(
        self, test_db, test_user
    ) -> None:
        knowledge_base_id = KnowledgeService.create_knowledge_base(
            db=test_db,
            user_id=test_user.id,
            data=KnowledgeBaseCreate(name="large-notebook-kb", kb_type="notebook"),
        )

        for index in range(51):
            KnowledgeService.create_document(
                db=test_db,
                knowledge_base_id=knowledge_base_id,
                user_id=test_user.id,
                data=KnowledgeDocumentCreate(
                    name=f"doc-{index}.md",
                    file_extension="md",
                    file_size=100,
                    source_type=DocumentSourceType.TEXT,
                ),
            )

        assert KnowledgeService.get_document_count(test_db, knowledge_base_id) == 51

    def test_default_view_can_be_changed_to_notebook_with_more_than_50_documents(
        self, test_db, test_user
    ) -> None:
        knowledge_base_id = KnowledgeService.create_knowledge_base(
            db=test_db,
            user_id=test_user.id,
            data=KnowledgeBaseCreate(name="large-documents-kb", kb_type="classic"),
        )
        for index in range(51):
            KnowledgeService.create_document(
                db=test_db,
                knowledge_base_id=knowledge_base_id,
                user_id=test_user.id,
                data=KnowledgeDocumentCreate(
                    name=f"doc-{index}.md",
                    file_extension="md",
                    file_size=100,
                    source_type=DocumentSourceType.TEXT,
                ),
            )

        updated = KnowledgeService.update_knowledge_base_type(
            db=test_db,
            knowledge_base_id=knowledge_base_id,
            user_id=test_user.id,
            new_type="notebook",
        )

        assert updated is not None
        assert updated.json["spec"]["kbType"] == "notebook"


@pytest.mark.unit
class TestKnowledgeServiceDocumentCountSemantics:
    def test_chat_grouped_and_bound_counts_include_inactive_documents(
        self, test_db, test_user
    ) -> None:
        knowledge_base_id = KnowledgeService.create_knowledge_base(
            db=test_db,
            user_id=test_user.id,
            data=KnowledgeBaseCreate(name="chat-count-kb"),
        )
        test_db.add_all(
            [
                KnowledgeDocument(
                    kind_id=knowledge_base_id,
                    folder_id=0,
                    attachment_id=0,
                    name="indexed.md",
                    file_extension="md",
                    file_size=10,
                    user_id=test_user.id,
                    is_active=True,
                    source_type="file",
                ),
                KnowledgeDocument(
                    kind_id=knowledge_base_id,
                    folder_id=0,
                    attachment_id=0,
                    name="pending.md",
                    file_extension="md",
                    file_size=10,
                    user_id=test_user.id,
                    is_active=False,
                    source_type="file",
                ),
            ]
        )
        task = TaskResource(
            user_id=test_user.id,
            kind="Task",
            name="chat-count-task",
            namespace="default",
            json={
                "kind": "Task",
                "metadata": {"name": "chat-count-task", "namespace": "default"},
                "spec": {
                    "knowledgeBaseRefs": [
                        {
                            "id": knowledge_base_id,
                            "name": "chat-count-kb",
                            "boundBy": test_user.user_name,
                            "boundAt": "2026-07-09T00:00:00Z",
                        }
                    ]
                },
            },
            is_active=TaskResource.STATE_ACTIVE,
        )
        test_db.add(task)
        test_db.commit()
        test_db.refresh(task)

        all_grouped = KnowledgeService.get_all_knowledge_bases_grouped(
            test_db, test_user.id
        )
        grouped_kb = next(
            item
            for item in all_grouped.personal.created_by_me
            if item.id == knowledge_base_id
        )
        assert grouped_kb.document_count == 2

        with patch(
            "app.services.knowledge.task_knowledge_base_service.task_member_service"
        ) as mock_member_service:
            mock_member_service.is_member.return_value = True
            bound = TaskKnowledgeBaseService().get_bound_knowledge_bases(
                test_db, task.id, test_user.id
            )

        assert bound[0].document_count == 2


@pytest.mark.unit
class TestKnowledgeServiceDocumentFolderQueries:
    def test_root_folder_with_subfolders_includes_all_descendants(
        self, test_db, test_user
    ) -> None:
        knowledge_base_id = KnowledgeService.create_knowledge_base(
            db=test_db,
            user_id=test_user.id,
            data=KnowledgeBaseCreate(name="root-subtree-documents"),
        )
        parent = KnowledgeFolderService.create_folder(
            test_db,
            knowledge_base_id,
            test_user.id,
            KnowledgeFolderCreate(name="parent", parent_id=0),
        )
        child = KnowledgeFolderService.create_folder(
            test_db,
            knowledge_base_id,
            test_user.id,
            KnowledgeFolderCreate(name="child", parent_id=parent.id),
        )
        root_doc = KnowledgeDocument(
            kind_id=knowledge_base_id,
            folder_id=0,
            attachment_id=0,
            name="root.md",
            file_extension="md",
            file_size=10,
            user_id=test_user.id,
            is_active=True,
            source_type="file",
        )
        child_doc = KnowledgeDocument(
            kind_id=knowledge_base_id,
            folder_id=child.id,
            attachment_id=0,
            name="child.md",
            file_extension="md",
            file_size=10,
            user_id=test_user.id,
            is_active=True,
            source_type="file",
        )
        test_db.add_all([root_doc, child_doc])
        test_db.commit()

        documents, total = KnowledgeService.list_documents_paginated(
            test_db,
            knowledge_base_id,
            test_user.id,
            folder_id=0,
            include_subfolders=True,
        )

        assert total == 2
        assert {doc.name for doc in documents} == {"root.md", "child.md"}

    def test_update_folder_returns_subtree_total_document_count(
        self, test_db, test_user
    ) -> None:
        knowledge_base_id = KnowledgeService.create_knowledge_base(
            db=test_db,
            user_id=test_user.id,
            data=KnowledgeBaseCreate(name="folder-update-subtree-count"),
        )
        parent = KnowledgeFolderService.create_folder(
            test_db,
            knowledge_base_id,
            test_user.id,
            KnowledgeFolderCreate(name="parent", parent_id=0),
        )
        child = KnowledgeFolderService.create_folder(
            test_db,
            knowledge_base_id,
            test_user.id,
            KnowledgeFolderCreate(name="child", parent_id=parent.id),
        )
        test_db.add_all(
            [
                KnowledgeDocument(
                    kind_id=knowledge_base_id,
                    folder_id=parent.id,
                    attachment_id=0,
                    name="parent.md",
                    file_extension="md",
                    file_size=10,
                    user_id=test_user.id,
                    is_active=True,
                    source_type="file",
                ),
                KnowledgeDocument(
                    kind_id=knowledge_base_id,
                    folder_id=child.id,
                    attachment_id=0,
                    name="child.md",
                    file_extension="md",
                    file_size=10,
                    user_id=test_user.id,
                    is_active=True,
                    source_type="file",
                ),
            ]
        )
        test_db.commit()

        updated = KnowledgeFolderService.update_folder(
            test_db,
            parent.id,
            test_user.id,
            KnowledgeFolderUpdate(name="renamed-parent"),
            knowledge_base_id=knowledge_base_id,
        )

        assert updated.direct_document_count == 1
        assert updated.total_document_count == 2


@pytest.mark.unit
class TestKnowledgeServiceUpdateDocumentContent:
    def test_update_document_content_overwrites_attachment_binary(self) -> None:
        """Editable documents should update attachment storage before reindexing."""
        db = MagicMock()
        document = SimpleNamespace(
            id=1,
            kind_id=10,
            source_type="text",
            file_extension="md",
            attachment_id=20,
            name="release-notes",
            file_size=12,
        )
        knowledge_base = SimpleNamespace(namespace="default")
        attachment = SimpleNamespace(
            id=20,
            original_filename="release-notes.md",
        )

        kb_query = MagicMock()
        kb_query.filter.return_value.first.return_value = knowledge_base

        attachment_query = MagicMock()
        attachment_query.filter.return_value.first.return_value = attachment

        db.query.side_effect = [kb_query, attachment_query]

        with (
            patch.object(KnowledgeService, "get_document", return_value=document),
            patch.object(
                context_service, "overwrite_attachment_internal"
            ) as mock_overwrite_attachment,
        ):
            result = KnowledgeService.update_document_content(
                db=db,
                document_id=document.id,
                content="# Updated release notes",
                user_id=99,
            )

        assert result is document
        assert document.file_size == len("# Updated release notes".encode("utf-8"))
        mock_overwrite_attachment.assert_called_once_with(
            db=db,
            context_id=20,
            filename="release-notes.md",
            reason="knowledge_manage",
            binary_data="# Updated release notes".encode("utf-8"),
        )
        db.refresh.assert_called_once_with(document)


@pytest.mark.unit
class TestKnowledgeServiceResolveDocumentIdsByNames:
    def test_resolve_document_ids_by_names_returns_only_active_docs_in_scope(
        self, test_db, test_user
    ) -> None:
        """Document-name resolution should ignore inactive and out-of-scope rows."""
        active_doc = KnowledgeDocument(
            kind_id=10,
            attachment_id=0,
            name="release.md",
            file_extension="md",
            file_size=10,
            user_id=test_user.id,
            is_active=True,
            source_type="file",
        )
        inactive_doc = KnowledgeDocument(
            kind_id=10,
            attachment_id=0,
            name="release.md",
            file_extension="md",
            file_size=10,
            user_id=test_user.id,
            is_active=False,
            source_type="file",
        )
        other_kb_doc = KnowledgeDocument(
            kind_id=11,
            attachment_id=0,
            name="release.md",
            file_extension="md",
            file_size=10,
            user_id=test_user.id,
            is_active=True,
            source_type="file",
        )
        test_db.add_all([active_doc, inactive_doc, other_kb_doc])
        test_db.commit()

        resolved_ids = KnowledgeService.resolve_document_ids_by_names(
            db=test_db,
            knowledge_base_ids=[10],
            document_names=["release.md"],
        )

        assert resolved_ids == [active_doc.id]


@pytest.mark.unit
class TestKnowledgeServiceGetDocumentPromptStats:
    def test_get_document_prompt_stats_counts_only_active_spreadsheets(
        self, test_db, test_user
    ) -> None:
        """Spreadsheet count should reflect searchable spreadsheet documents only."""
        active_csv = KnowledgeDocument(
            kind_id=10,
            attachment_id=0,
            name="active-report.csv",
            file_extension="csv",
            file_size=10,
            user_id=test_user.id,
            is_active=True,
            source_type="file",
        )
        inactive_xlsx = KnowledgeDocument(
            kind_id=10,
            attachment_id=0,
            name="inactive-report.xlsx",
            file_extension="xlsx",
            file_size=10,
            user_id=test_user.id,
            is_active=False,
            source_type="file",
        )
        active_markdown = KnowledgeDocument(
            kind_id=10,
            attachment_id=0,
            name="guide.md",
            file_extension="md",
            file_size=10,
            user_id=test_user.id,
            is_active=True,
            source_type="file",
        )
        test_db.add_all([active_csv, inactive_xlsx, active_markdown])
        test_db.commit()

        stats = KnowledgeService.get_document_prompt_stats(
            db=test_db,
            knowledge_base_ids=[10],
        )

        assert stats[10] == {
            "total_document_count": 3,
            "searchable_document_count": 2,
            "spreadsheet_document_count": 1,
        }


@pytest.mark.unit
class TestKnowledgeServiceDeleteDocument:
    def test_delete_document_routes_cleanup_with_resolved_owner_scope(self) -> None:
        db = MagicMock()
        document = SimpleNamespace(
            id=8,
            kind_id=10,
            attachment_id=20,
            user_id=42,
            converted_attachment_id=None,
        )
        knowledge_base = SimpleNamespace(
            id=10,
            user_id=42,
            namespace="default",
            json={
                "spec": {
                    "retrievalConfig": {
                        "retriever_name": "retriever-a",
                        "retriever_namespace": "default",
                    }
                }
            },
        )

        kb_query = MagicMock()
        kb_query.filter.return_value.first.return_value = knowledge_base
        db.query.return_value = kb_query
        delete_runtime_spec = object()
        mock_gateway = MagicMock()
        mock_gateway.delete_document_index = MagicMock()

        with (
            patch.object(KnowledgeService, "get_document", return_value=document),
            patch.object(
                KnowledgeService,
                "_assert_can_manage_document",
                return_value=None,
            ),
            patch.object(
                KnowledgeService,
                "_update_document_count_cache",
                return_value=None,
            ),
            patch(
                "app.services.knowledge.index_runtime.build_kb_index_info",
                return_value=SimpleNamespace(
                    index_owner_user_id=7, summary_enabled=False
                ),
            ) as build_kb_index_info,
            patch.object(
                context_service,
                "delete_context",
                return_value=True,
            ) as mock_delete_context,
            patch(
                "app.services.knowledge.knowledge_service._get_delete_gateway",
                return_value=mock_gateway,
            ),
            patch(
                "app.services.rag.runtime_resolver.RagRuntimeResolver.build_delete_runtime_spec",
                return_value=delete_runtime_spec,
            ) as mock_build_delete_runtime_spec,
            patch(
                "app.services.knowledge.knowledge_service._run_async_in_new_loop",
                return_value={"status": "success"},
            ) as run_async_in_new_loop,
        ):
            KnowledgeService.delete_document(
                db=db,
                document_id=8,
                user_id=7,
            )

        run_async_in_new_loop.assert_called_once()
        mock_build_delete_runtime_spec.assert_called_once_with(
            db=db,
            knowledge_base_id=10,
            document_ref="8",
            index_owner_user_id=7,
        )
        build_kb_index_info.assert_called_once_with(
            db=db,
            knowledge_base=knowledge_base,
            current_user_id=7,
        )
        # Original attachment must be deleted with the document owner's user_id,
        # not the requester's, because delete_context enforces ownership filtering.
        mock_delete_context.assert_called_once_with(db=db, context_id=20, user_id=42)

    def test_delete_document_uses_owner_id_for_both_attachments(self) -> None:
        """Both original and converted attachments must be deleted with the
        document owner's user_id, not the requester's. delete_context enforces
        ownership filtering — passing the requester's id would silently fail
        and leave orphaned context/storage when an admin deletes another user's
        document."""
        db = MagicMock()
        document = SimpleNamespace(
            id=9,
            kind_id=10,
            attachment_id=30,
            user_id=42,
            converted_attachment_id=99,
        )
        knowledge_base = SimpleNamespace(
            id=10,
            user_id=42,
            namespace="default",
            json={
                "spec": {
                    "retrievalConfig": {
                        "retriever_name": "retriever-a",
                        "retriever_namespace": "default",
                    }
                }
            },
        )

        kb_query = MagicMock()
        kb_query.filter.return_value.first.return_value = knowledge_base
        db.query.return_value = kb_query
        mock_gateway = MagicMock()
        mock_gateway.delete_document_index = MagicMock()

        with (
            patch.object(KnowledgeService, "get_document", return_value=document),
            patch.object(
                KnowledgeService,
                "_assert_can_manage_document",
                return_value=None,
            ),
            patch.object(
                KnowledgeService,
                "_update_document_count_cache",
                return_value=None,
            ),
            patch(
                "app.services.knowledge.index_runtime.build_kb_index_info",
                return_value=SimpleNamespace(
                    index_owner_user_id=7, summary_enabled=False
                ),
            ),
            patch.object(
                context_service,
                "delete_context",
                return_value=True,
            ) as mock_delete_context,
            patch(
                "app.services.knowledge.knowledge_service._get_delete_gateway",
                return_value=mock_gateway,
            ),
            patch(
                "app.services.rag.runtime_resolver.RagRuntimeResolver.build_delete_runtime_spec",
                return_value=object(),
            ),
            patch(
                "app.services.knowledge.knowledge_service._run_async_in_new_loop",
                return_value={"status": "success"},
            ),
        ):
            KnowledgeService.delete_document(
                db=db,
                document_id=9,
                user_id=7,
            )

        # Both calls must use the document owner's user_id (42), not the requester's (7)
        assert mock_delete_context.call_count == 2
        mock_delete_context.assert_any_call(db=db, context_id=30, user_id=42)
        mock_delete_context.assert_any_call(db=db, context_id=99, user_id=42)

    def test_delete_document_treats_deleted_status_as_success(self) -> None:
        db = MagicMock()
        document = SimpleNamespace(
            id=8,
            kind_id=10,
            attachment_id=None,
            user_id=42,
            converted_attachment_id=None,
        )
        knowledge_base = SimpleNamespace(
            id=10,
            user_id=42,
            namespace="default",
            json={
                "spec": {
                    "retrievalConfig": {
                        "retriever_name": "retriever-a",
                        "retriever_namespace": "default",
                    }
                }
            },
        )

        kb_query = MagicMock()
        kb_query.filter.return_value.first.return_value = knowledge_base
        db.query.return_value = kb_query
        delete_runtime_spec = object()
        mock_gateway = MagicMock()
        mock_gateway.delete_document_index = MagicMock()

        with (
            patch.object(KnowledgeService, "get_document", return_value=document),
            patch.object(
                KnowledgeService,
                "_assert_can_manage_document",
                return_value=None,
            ),
            patch.object(
                KnowledgeService,
                "_update_document_count_cache",
                return_value=None,
            ),
            patch(
                "app.services.knowledge.index_runtime.build_kb_index_info",
                return_value=SimpleNamespace(
                    index_owner_user_id=42, summary_enabled=False
                ),
            ),
            patch(
                "app.services.knowledge.knowledge_service._get_delete_gateway",
                return_value=mock_gateway,
            ),
            patch(
                "app.services.rag.runtime_resolver.RagRuntimeResolver.build_delete_runtime_spec",
                return_value=delete_runtime_spec,
            ),
            patch("logging.getLogger") as mock_logger,
            patch(
                "app.services.knowledge.knowledge_service._run_async_in_new_loop",
                return_value={
                    "status": "deleted",
                    "deleted_chunks": 3,
                    "deleted_parent_nodes": 1,
                    "index_name": "test_user_42",
                },
            ) as run_async_in_new_loop,
        ):
            KnowledgeService.delete_document(
                db=db,
                document_id=8,
                user_id=7,
            )

        run_async_in_new_loop.assert_called_once()
        mock_logger.return_value.info.assert_any_call(
            "Deleted RAG index for doc_ref '%s' in knowledge base %s "
            "(index_owner_user_id=%s, status=%s, deleted_chunks=%s, "
            "deleted_parent_nodes=%s, index_name=%s)",
            "8",
            10,
            42,
            "deleted",
            3,
            1,
            "test_user_42",
        )
        mock_logger.return_value.warning.assert_not_called()


@pytest.mark.unit
class TestRunAsyncInNewLoop:
    def test_cancels_pending_tasks_before_closing_loop(self) -> None:
        cancelled = threading.Event()

        async def background_task() -> None:
            try:
                await asyncio.sleep(3600)
            except asyncio.CancelledError:
                cancelled.set()
                raise

        async def main_coro() -> str:
            asyncio.create_task(background_task())
            return "done"

        result = _run_async_in_new_loop(main_coro())

        assert result == "done"
        assert cancelled.wait(timeout=1.0)

    def test_cleans_up_pending_tasks_when_main_coro_raises(self) -> None:
        cancelled = threading.Event()

        async def background_task() -> None:
            try:
                await asyncio.sleep(3600)
            except asyncio.CancelledError:
                cancelled.set()
                raise

        async def failing_coro() -> None:
            asyncio.create_task(background_task())
            raise RuntimeError("boom")

        with pytest.raises(RuntimeError, match="boom"):
            _run_async_in_new_loop(failing_coro())

        assert cancelled.wait(timeout=1.0)
