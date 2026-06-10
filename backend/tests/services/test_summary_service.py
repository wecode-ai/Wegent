# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Unit tests for SummaryService, focusing on KB summary operations after document deletion.
"""

from datetime import datetime
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.knowledge import KnowledgeDocument
from app.models.user import User
from app.services.background_chat_executor import BackgroundTaskResult
from app.services.knowledge import SummaryService, get_summary_service
from app.services.knowledge.summary_service import DocumentAggregation


class TestTriggerKbSummaryClearIfEmpty:
    """Test the trigger_kb_summary method with clear_if_empty parameter."""

    @pytest.fixture
    def test_knowledge_base(self, test_db: Session, test_user: User) -> Kind:
        """Create a test knowledge base."""
        kb_json = {
            "apiVersion": "agent.wecode.io/v1",
            "kind": "KnowledgeBase",
            "metadata": {
                "name": f"test-kb-{test_user.id}",
                "namespace": "default",
            },
            "spec": {
                "name": "Test Knowledge Base",
                "description": "A test knowledge base",
                "summaryEnabled": True,
                "summary": {
                    "status": "completed",
                    "short_summary": "Test summary",
                    "long_summary": "A longer test summary",
                    "topics": ["topic1", "topic2"],
                    "updated_at": datetime.now().isoformat(),
                },
            },
            "status": {"state": "Available"},
        }
        kb = Kind(
            user_id=test_user.id,
            kind="KnowledgeBase",
            name=f"test-kb-{test_user.id}",
            namespace="default",
            json=kb_json,
            created_at=datetime.now(),
            updated_at=datetime.now(),
        )
        test_db.add(kb)
        test_db.commit()
        test_db.refresh(kb)
        return kb

    @pytest.fixture
    def test_document(
        self, test_db: Session, test_user: User, test_knowledge_base: Kind
    ) -> KnowledgeDocument:
        """Create a test document."""
        doc = KnowledgeDocument(
            kind_id=test_knowledge_base.id,
            attachment_id=0,
            name="test_document.pdf",
            file_extension="pdf",
            file_size=1024,
            user_id=test_user.id,
            is_active=True,
            source_type="file",
        )
        test_db.add(doc)
        test_db.commit()
        test_db.refresh(doc)
        return doc

    @pytest.mark.asyncio
    async def test_clear_if_empty_clears_summary_when_no_documents(
        self, test_db: Session, test_user: User, test_knowledge_base: Kind
    ):
        """Test that clear_if_empty=True clears KB summary when no active documents exist."""
        summary_service = get_summary_service(test_db)

        # Verify summary exists before
        kb = test_db.query(Kind).filter(Kind.id == test_knowledge_base.id).first()
        assert kb.json["spec"]["summary"] is not None

        # Trigger with clear_if_empty=True (no active documents)
        result = await summary_service.trigger_kb_summary(
            test_knowledge_base.id,
            test_user.id,
            test_user.user_name,
            force=False,
            clear_if_empty=True,
        )

        # Should return None (no summary generated)
        assert result is None

        # Verify summary is cleared
        test_db.refresh(kb)
        assert kb.json["spec"]["summary"] is None

    @pytest.mark.asyncio
    async def test_clear_if_empty_does_not_clear_when_documents_exist(
        self,
        test_db: Session,
        test_user: User,
        test_knowledge_base: Kind,
        test_document: KnowledgeDocument,
    ):
        """Test that clear_if_empty=True does NOT clear summary when active documents exist."""
        # Add summary to the document so it counts as "completed"
        test_document.summary = {
            "status": "completed",
            "short_summary": "Document summary",
            "topics": ["topic1"],
        }
        test_db.commit()

        summary_service = get_summary_service(test_db)

        # Verify summary exists before
        kb = test_db.query(Kind).filter(Kind.id == test_knowledge_base.id).first()
        original_summary = kb.json["spec"]["summary"]
        assert original_summary is not None

        # Trigger with clear_if_empty=True
        # Since document exists with completed summary, it should try to regenerate
        # But we don't have BackgroundChatExecutor mocked, so it will fail
        # The important thing is that summary should NOT be cleared
        with patch(
            "app.services.knowledge.summary_service.BackgroundChatExecutor"
        ) as mock_executor:
            mock_instance = MagicMock()
            mock_instance.execute = AsyncMock(
                return_value=MagicMock(
                    success=True,
                    parsed_content={
                        "short_summary": "New summary",
                        "long_summary": "New longer summary",
                        "topics": ["new_topic"],
                    },
                    task_id=123,
                )
            )
            mock_executor.with_short_sessions.return_value = mock_instance

            result = await summary_service.trigger_kb_summary(
                test_knowledge_base.id,
                test_user.id,
                test_user.user_name,
                force=False,
                clear_if_empty=True,
            )

        # Summary should be updated (not cleared)
        test_db.refresh(kb)
        assert kb.json["spec"]["summary"] is not None
        assert kb.json["spec"]["summary"]["status"] == "completed"

    @pytest.mark.asyncio
    async def test_clear_if_empty_false_does_not_clear(
        self, test_db: Session, test_user: User, test_knowledge_base: Kind
    ):
        """Test that clear_if_empty=False (default) does NOT clear summary."""
        summary_service = get_summary_service(test_db)

        # Verify summary exists before
        kb = test_db.query(Kind).filter(Kind.id == test_knowledge_base.id).first()
        original_summary = kb.json["spec"]["summary"]
        assert original_summary is not None

        # Trigger without clear_if_empty (defaults to False)
        result = await summary_service.trigger_kb_summary(
            test_knowledge_base.id, test_user.id, test_user.user_name, force=False
        )

        # Should return None (no documents to summarize)
        assert result is None

        # Verify summary is NOT cleared
        test_db.refresh(kb)
        assert kb.json["spec"]["summary"] is not None
        assert kb.json["spec"]["summary"]["short_summary"] == "Test summary"

    @pytest.mark.asyncio
    async def test_clear_if_empty_kb_not_found(self, test_db: Session, test_user: User):
        """Test trigger_kb_summary with non-existent KB."""
        summary_service = get_summary_service(test_db)

        result = await summary_service.trigger_kb_summary(
            99999, test_user.id, test_user.user_name, force=False, clear_if_empty=True
        )

        assert result is None

    @pytest.mark.asyncio
    async def test_clear_if_empty_still_clears_when_summary_disabled(
        self, test_db: Session, test_user: User, test_knowledge_base: Kind
    ):
        """Test clear_if_empty=True still clears stale AI summary when summary is disabled."""
        test_knowledge_base.json["spec"]["summaryEnabled"] = False
        test_db.commit()

        summary_service = get_summary_service(test_db)
        kb = test_db.query(Kind).filter(Kind.id == test_knowledge_base.id).first()
        assert kb is not None
        assert kb.json["spec"]["summary"] is not None

        result = await summary_service.trigger_kb_summary(
            test_knowledge_base.id,
            test_user.id,
            test_user.user_name,
            force=False,
            clear_if_empty=True,
        )

        assert result is None
        test_db.refresh(kb)
        assert kb.json["spec"]["summary"] is None


class TestManualKnowledgeBaseSummary:
    """Test manual KB summary overrides."""

    @pytest.fixture
    def test_knowledge_base(self, test_db: Session, test_user: User) -> Kind:
        kb_json = {
            "apiVersion": "agent.wecode.io/v1",
            "kind": "KnowledgeBase",
            "metadata": {
                "name": f"test-kb-manual-{test_user.id}",
                "namespace": "default",
            },
            "spec": {
                "name": "Manual Summary KB",
                "description": "A KB for manual summary tests",
                "summaryEnabled": True,
                "summaryModelRef": {
                    "name": "test-summary-model",
                    "namespace": "default",
                    "type": "public",
                },
                "summary": {
                    "status": "completed",
                    "short_summary": "AI short summary",
                    "long_summary": "AI long summary",
                    "topics": ["topic1"],
                    "updated_at": datetime.now().isoformat(),
                },
            },
            "status": {"state": "Available"},
        }
        kb = Kind(
            user_id=test_user.id,
            kind="KnowledgeBase",
            name=f"test-kb-manual-{test_user.id}",
            namespace="default",
            json=kb_json,
            created_at=datetime.now(),
            updated_at=datetime.now(),
        )
        test_db.add(kb)
        test_db.commit()
        test_db.refresh(kb)
        return kb

    @pytest.mark.asyncio
    async def test_update_manual_summary_sets_override_fields(
        self, test_db: Session, test_user: User, test_knowledge_base: Kind
    ):
        summary_service = get_summary_service(test_db)

        summary = await summary_service.update_kb_manual_summary(
            test_knowledge_base.id,
            test_user.id,
            test_user.user_name,
            "Manual long summary",
        )

        assert summary is not None
        assert summary.long_summary == "AI long summary"
        assert summary.manual_long_summary == "Manual long summary"
        assert summary.manual_updated_by is not None
        assert summary.manual_updated_by.name == test_user.user_name
        assert summary.status == "completed"

    @pytest.mark.asyncio
    async def test_reset_manual_summary_clears_override_fields(
        self, test_db: Session, test_user: User, test_knowledge_base: Kind
    ):
        summary_service = get_summary_service(test_db)
        await summary_service.update_kb_manual_summary(
            test_knowledge_base.id,
            test_user.id,
            test_user.user_name,
            "Manual long summary",
        )

        summary = await summary_service.reset_kb_manual_summary(test_knowledge_base.id)

        assert summary is not None
        assert summary.long_summary == "AI long summary"
        assert summary.manual_long_summary is None

    @pytest.mark.asyncio
    async def test_update_manual_summary_does_not_set_completed_without_ai_summary(
        self, test_db: Session, test_user: User
    ):
        kb_json = {
            "apiVersion": "agent.wecode.io/v1",
            "kind": "KnowledgeBase",
            "metadata": {
                "name": f"test-kb-pending-{test_user.id}",
                "namespace": "default",
            },
            "spec": {
                "name": "Pending KB",
                "description": "A KB without AI summary",
                "summaryEnabled": True,
                "summary": {
                    "status": "pending",
                },
            },
            "status": {"state": "Available"},
        }
        kb = Kind(
            user_id=test_user.id,
            kind="KnowledgeBase",
            name=f"test-kb-pending-{test_user.id}",
            namespace="default",
            json=kb_json,
            created_at=datetime.now(),
            updated_at=datetime.now(),
        )
        test_db.add(kb)
        test_db.commit()
        test_db.refresh(kb)

        summary_service = get_summary_service(test_db)
        summary = await summary_service.update_kb_manual_summary(
            kb.id,
            test_user.id,
            test_user.user_name,
            "Manual long summary",
        )

        assert summary is not None
        assert summary.status == "pending"
        assert summary.manual_long_summary == "Manual long summary"

    @pytest.mark.asyncio
    async def test_trigger_kb_summary_preserves_manual_summary_and_updates_ai_fields(
        self, test_db: Session, test_user: User, test_knowledge_base: Kind
    ):
        summary_service = get_summary_service(test_db)
        await summary_service.update_kb_manual_summary(
            test_knowledge_base.id,
            test_user.id,
            test_user.user_name,
            "Manual long summary",
        )

        doc = KnowledgeDocument(
            kind_id=test_knowledge_base.id,
            attachment_id=0,
            name="doc.pdf",
            file_extension="pdf",
            file_size=100,
            user_id=test_user.id,
            is_active=True,
            source_type="file",
            summary={
                "status": "completed",
                "short_summary": "Doc summary",
                "topics": ["topic2"],
            },
        )
        test_db.add(doc)
        test_db.commit()

        with patch(
            "app.services.knowledge.summary_service.BackgroundChatExecutor"
        ) as mock_executor:
            mock_instance = MagicMock()
            mock_instance.execute = AsyncMock(
                return_value=MagicMock(
                    success=True,
                    parsed_content={
                        "short_summary": "New AI short summary",
                        "long_summary": "New AI long summary",
                        "topics": ["new_topic"],
                    },
                    task_id=456,
                )
            )
            mock_executor.with_short_sessions.return_value = mock_instance
            with patch.object(
                summary_service,
                "_get_model_config_from_kb",
                return_value={"model_name": "summary-model"},
            ):
                await summary_service.trigger_kb_summary(
                    test_knowledge_base.id,
                    test_user.id,
                    test_user.user_name,
                    force=True,
                )

        refreshed_summary = await summary_service.get_kb_summary(test_knowledge_base.id)
        assert refreshed_summary is not None
        assert refreshed_summary.long_summary == "New AI long summary"
        assert refreshed_summary.manual_long_summary == "Manual long summary"

    @pytest.mark.asyncio
    async def test_kb_summary_commits_generating_status_before_model_call(
        self, test_db: Session, test_user: User, test_knowledge_base: Kind, monkeypatch
    ):
        summary_service = get_summary_service(test_db)
        commit_count_at_execute = None
        query_count_at_execute = None
        original_commit = test_db.commit
        original_query = test_db.query
        test_db.commit = MagicMock(wraps=original_commit)
        test_db.query = MagicMock(wraps=original_query)

        async def fake_execute(*args, **kwargs):
            nonlocal commit_count_at_execute, query_count_at_execute
            commit_count_at_execute = test_db.commit.call_count
            query_count_at_execute = test_db.query.call_count
            return BackgroundTaskResult(
                success=True,
                parsed_content={
                    "short_summary": "New AI short summary",
                    "long_summary": "New AI long summary",
                    "topics": ["new_topic"],
                },
                task_id="summary-task",
                subtask_id="summary-subtask",
                raw_content="{}",
            )

        monkeypatch.setattr(
            "app.services.knowledge.summary_service.BackgroundChatExecutor.execute",
            fake_execute,
        )
        monkeypatch.setattr(
            summary_service,
            "_get_document_aggregation",
            lambda kb_id: DocumentAggregation(
                aggregated_text="document summary",
                completed_count=1,
            ),
        )
        monkeypatch.setattr(
            summary_service,
            "_get_model_config_from_kb",
            lambda kb, user_id, user_name: {"model": "test-model"},
        )

        await summary_service.trigger_kb_summary(
            kb_id=test_knowledge_base.id,
            user_id=test_user.id,
            user_name=test_user.user_name,
            force=True,
        )

        assert commit_count_at_execute is not None
        assert commit_count_at_execute >= 1
        assert test_db.query.call_count > query_count_at_execute

    @pytest.mark.asyncio
    async def test_kb_summary_executor_uses_independent_session(
        self, test_db: Session, test_user: User, test_knowledge_base: Kind, monkeypatch
    ):
        summary_service = get_summary_service(test_db)
        test_db.rollback = MagicMock()

        executor_instance = MagicMock()
        executor_instance.execute = AsyncMock(
            return_value=BackgroundTaskResult(
                success=True,
                parsed_content={
                    "short_summary": "New AI short summary",
                    "long_summary": "New AI long summary",
                    "topics": ["new_topic"],
                },
                task_id="summary-task",
                subtask_id="summary-subtask",
                raw_content="{}",
            )
        )
        executor_cls = MagicMock()
        executor_cls.with_short_sessions.return_value = executor_instance

        monkeypatch.setattr(
            summary_service,
            "_get_document_aggregation",
            lambda kb_id: DocumentAggregation(
                aggregated_text="document summary",
                completed_count=1,
            ),
        )
        monkeypatch.setattr(
            summary_service,
            "_get_model_config_from_kb",
            lambda kb, user_id, user_name: {"model": "test-model"},
        )

        with patch(
            "app.services.knowledge.summary_service.BackgroundChatExecutor",
            executor_cls,
        ):
            await summary_service.trigger_kb_summary(
                kb_id=test_knowledge_base.id,
                user_id=test_user.id,
                user_name=test_user.user_name,
                force=True,
            )

        executor_cls.with_short_sessions.assert_called_once_with(test_user.id)
        test_db.rollback.assert_not_called()

    @pytest.mark.asyncio
    async def test_trigger_kb_summary_skips_when_summary_disabled(
        self, test_db: Session, test_user: User
    ):
        kb_json = {
            "apiVersion": "agent.wecode.io/v1",
            "kind": "KnowledgeBase",
            "metadata": {
                "name": f"test-kb-disabled-{test_user.id}",
                "namespace": "default",
            },
            "spec": {
                "name": "Disabled Summary KB",
                "description": "A KB with disabled AI summary",
                "summaryEnabled": False,
                "summary": {
                    "status": "pending",
                },
            },
            "status": {"state": "Available"},
        }
        kb = Kind(
            user_id=test_user.id,
            kind="KnowledgeBase",
            name=f"test-kb-disabled-{test_user.id}",
            namespace="default",
            json=kb_json,
            created_at=datetime.now(),
            updated_at=datetime.now(),
        )
        test_db.add(kb)
        test_db.commit()
        test_db.refresh(kb)

        summary_service = get_summary_service(test_db)
        result = await summary_service.trigger_kb_summary(
            kb.id,
            test_user.id,
            test_user.user_name,
            force=True,
        )

        assert result is None

    @pytest.mark.asyncio
    async def test_clear_if_empty_summary_already_none(
        self, test_db: Session, test_user: User
    ):
        """Test clear_if_empty when summary is already None (idempotent)."""
        # Create a KB without summary
        kb_json = {
            "apiVersion": "agent.wecode.io/v1",
            "kind": "KnowledgeBase",
            "metadata": {
                "name": f"test-kb-no-summary-{test_user.id}",
                "namespace": "default",
            },
            "spec": {
                "name": "Test KB No Summary",
                "description": "A test knowledge base without summary",
                "summaryEnabled": True,
                "summary": None,
            },
            "status": {"state": "Available"},
        }
        kb = Kind(
            user_id=test_user.id,
            kind="KnowledgeBase",
            name=f"test-kb-no-summary-{test_user.id}",
            namespace="default",
            json=kb_json,
            created_at=datetime.now(),
            updated_at=datetime.now(),
        )
        test_db.add(kb)
        test_db.commit()
        test_db.refresh(kb)

        summary_service = get_summary_service(test_db)

        # Clear again - should work without error
        result = await summary_service.trigger_kb_summary(
            kb.id, test_user.id, test_user.user_name, force=False, clear_if_empty=True
        )

        assert result is None

        # Verify summary is still None
        test_db.refresh(kb)
        assert kb.json["spec"]["summary"] is None

    @pytest.mark.asyncio
    async def test_clear_if_empty_only_counts_active_documents(
        self,
        test_db: Session,
        test_user: User,
        test_knowledge_base: Kind,
    ):
        """Test that only is_active=True documents are counted."""
        # Create an inactive document with completed summary
        inactive_doc = KnowledgeDocument(
            kind_id=test_knowledge_base.id,
            attachment_id=0,
            name="inactive_document.pdf",
            file_extension="pdf",
            file_size=1024,
            user_id=test_user.id,
            is_active=False,  # Inactive
            source_type="file",
            summary={
                "status": "completed",
                "short_summary": "Inactive doc summary",
            },
        )
        test_db.add(inactive_doc)
        test_db.commit()

        summary_service = get_summary_service(test_db)

        # Should clear because no ACTIVE documents
        result = await summary_service.trigger_kb_summary(
            test_knowledge_base.id,
            test_user.id,
            test_user.user_name,
            force=False,
            clear_if_empty=True,
        )

        assert result is None

        # Verify summary is cleared
        kb = test_db.query(Kind).filter(Kind.id == test_knowledge_base.id).first()
        assert kb.json["spec"]["summary"] is None


class TestKnowledgeServiceDeleteDocument:
    """Test delete_document returning KB ID for summary updates."""

    @pytest.fixture
    def test_knowledge_base(self, test_db: Session, test_user: User) -> Kind:
        """Create a test knowledge base."""
        kb_json = {
            "apiVersion": "agent.wecode.io/v1",
            "kind": "KnowledgeBase",
            "metadata": {
                "name": f"test-kb-delete-{test_user.id}",
                "namespace": "default",
            },
            "spec": {
                "name": "Test Delete KB",
                "description": "A test knowledge base for deletion tests",
            },
            "status": {"state": "Available"},
        }
        kb = Kind(
            user_id=test_user.id,
            kind="KnowledgeBase",
            name=f"test-kb-delete-{test_user.id}",
            namespace="default",
            json=kb_json,
            created_at=datetime.now(),
            updated_at=datetime.now(),
        )
        test_db.add(kb)
        test_db.commit()
        test_db.refresh(kb)
        return kb

    @pytest.fixture
    def test_document(
        self, test_db: Session, test_user: User, test_knowledge_base: Kind
    ) -> KnowledgeDocument:
        """Create a test document."""
        doc = KnowledgeDocument(
            kind_id=test_knowledge_base.id,
            attachment_id=0,
            name="test_to_delete.pdf",
            file_extension="pdf",
            file_size=2048,
            user_id=test_user.id,
            is_active=True,
            source_type="file",
        )
        test_db.add(doc)
        test_db.commit()
        test_db.refresh(doc)
        return doc

    def test_delete_document_returns_kb_id(
        self,
        test_db: Session,
        test_user: User,
        test_knowledge_base: Kind,
        test_document: KnowledgeDocument,
    ):
        """Test that delete_document returns DocumentDeleteResult with kb_id."""
        from app.services.knowledge import KnowledgeService

        document_id = test_document.id
        expected_kb_id = test_knowledge_base.id

        result = KnowledgeService.delete_document(
            db=test_db,
            document_id=document_id,
            user_id=test_user.id,
        )

        assert result.success is True
        assert result.kb_id == expected_kb_id

        # Verify document is deleted
        deleted_doc = (
            test_db.query(KnowledgeDocument)
            .filter(KnowledgeDocument.id == document_id)
            .first()
        )
        assert deleted_doc is None

    def test_delete_document_not_found(self, test_db: Session, test_user: User):
        """Test delete_document returns failure when document not found."""
        from app.services.knowledge import KnowledgeService

        result = KnowledgeService.delete_document(
            db=test_db,
            document_id=99999,
            user_id=test_user.id,
        )

        assert result.success is False
        assert result.kb_id is None

    def test_delete_document_routes_rag_cleanup_through_gateway(
        self,
        test_db: Session,
        test_user: User,
        test_knowledge_base: Kind,
        test_document: KnowledgeDocument,
    ):
        """Test delete_document delegates RAG cleanup through the local gateway."""
        from sqlalchemy.orm.attributes import flag_modified

        from app.services.knowledge import KnowledgeService

        test_knowledge_base.json["spec"]["retrievalConfig"] = {
            "retriever_name": "retriever-a",
            "retriever_namespace": "default",
        }
        flag_modified(test_knowledge_base, "json")
        test_db.commit()
        delete_runtime_spec = object()
        mock_gateway = MagicMock()
        mock_gateway.delete_document_index = AsyncMock(
            return_value={"status": "success"}
        )

        with (
            patch(
                "app.services.rag.gateway_factory.get_delete_gateway",
                return_value=mock_gateway,
            ) as mock_get_delete_gateway,
            patch(
                "app.services.rag.runtime_resolver.RagRuntimeResolver.build_delete_runtime_spec",
                return_value=delete_runtime_spec,
            ) as mock_build_delete_runtime_spec,
        ):
            result = KnowledgeService.delete_document(
                db=test_db,
                document_id=test_document.id,
                user_id=test_user.id,
            )

        assert result.success is True
        mock_get_delete_gateway.assert_called_once()
        mock_build_delete_runtime_spec.assert_called_once_with(
            db=test_db,
            knowledge_base_id=test_knowledge_base.id,
            document_ref=str(test_document.id),
            index_owner_user_id=test_user.id,
        )
        mock_gateway.delete_document_index.assert_awaited_once_with(
            delete_runtime_spec,
            db=test_db,
        )
        assert mock_build_delete_runtime_spec.call_args.kwargs["knowledge_base_id"] == (
            test_knowledge_base.id
        )


class TestKnowledgeServiceBatchDeleteDocuments:
    """Test batch_delete_documents returning KB IDs for summary updates."""

    @pytest.fixture
    def test_knowledge_base(self, test_db: Session, test_user: User) -> Kind:
        """Create a test knowledge base."""
        kb_json = {
            "apiVersion": "agent.wecode.io/v1",
            "kind": "KnowledgeBase",
            "metadata": {
                "name": f"test-kb-batch-{test_user.id}",
                "namespace": "default",
            },
            "spec": {
                "name": "Test Batch KB",
                "description": "A test knowledge base for batch tests",
            },
            "status": {"state": "Available"},
        }
        kb = Kind(
            user_id=test_user.id,
            kind="KnowledgeBase",
            name=f"test-kb-batch-{test_user.id}",
            namespace="default",
            json=kb_json,
            created_at=datetime.now(),
            updated_at=datetime.now(),
        )
        test_db.add(kb)
        test_db.commit()
        test_db.refresh(kb)
        return kb

    @pytest.fixture
    def test_documents(
        self, test_db: Session, test_user: User, test_knowledge_base: Kind
    ) -> list[KnowledgeDocument]:
        """Create multiple test documents."""
        documents = []
        for i in range(3):
            doc = KnowledgeDocument(
                kind_id=test_knowledge_base.id,
                attachment_id=0,
                name=f"test_batch_doc_{i}.pdf",
                file_extension="pdf",
                file_size=1024 * (i + 1),
                user_id=test_user.id,
                is_active=True,
                source_type="file",
            )
            test_db.add(doc)
            documents.append(doc)
        test_db.commit()
        for doc in documents:
            test_db.refresh(doc)
        return documents

    def test_batch_delete_returns_kb_ids(
        self,
        test_db: Session,
        test_user: User,
        test_knowledge_base: Kind,
        test_documents: list[KnowledgeDocument],
    ):
        """Test that batch_delete_documents returns BatchDeleteResult with kb_ids."""
        from app.services.knowledge import KnowledgeService

        document_ids = [doc.id for doc in test_documents]
        expected_kb_id = test_knowledge_base.id

        result = KnowledgeService.batch_delete_documents(
            db=test_db,
            document_ids=document_ids,
            user_id=test_user.id,
        )

        assert result.result.success_count == 3
        assert result.result.failed_count == 0
        assert expected_kb_id in result.kb_ids

    def test_batch_delete_mixed_results(
        self,
        test_db: Session,
        test_user: User,
        test_knowledge_base: Kind,
        test_documents: list[KnowledgeDocument],
    ):
        """Test batch delete with some non-existent documents."""
        from app.services.knowledge import KnowledgeService

        # Mix existing and non-existent document IDs
        document_ids = [test_documents[0].id, 99999, test_documents[1].id]
        expected_kb_id = test_knowledge_base.id

        result = KnowledgeService.batch_delete_documents(
            db=test_db,
            document_ids=document_ids,
            user_id=test_user.id,
        )

        assert result.result.success_count == 2
        assert result.result.failed_count == 1
        assert 99999 in result.result.failed_ids
        assert expected_kb_id in result.kb_ids


class TestTriggerDocumentSummaryDeletionRace:
    """Test document summary generation when the document is deleted mid-flight."""

    @pytest.fixture
    def test_knowledge_base(self, test_db: Session, test_user: User) -> Kind:
        kb_json = {
            "apiVersion": "agent.wecode.io/v1",
            "kind": "KnowledgeBase",
            "metadata": {
                "name": f"test-kb-summary-race-{test_user.id}",
                "namespace": "default",
            },
            "spec": {
                "name": "Summary Race KB",
                "description": "A test knowledge base for summary race handling",
            },
            "status": {"state": "Available"},
        }
        kb = Kind(
            user_id=test_user.id,
            kind="KnowledgeBase",
            name=f"test-kb-summary-race-{test_user.id}",
            namespace="default",
            json=kb_json,
            created_at=datetime.now(),
            updated_at=datetime.now(),
        )
        test_db.add(kb)
        test_db.commit()
        test_db.refresh(kb)
        return kb

    @pytest.fixture
    def test_document(
        self, test_db: Session, test_user: User, test_knowledge_base: Kind
    ) -> KnowledgeDocument:
        doc = KnowledgeDocument(
            kind_id=test_knowledge_base.id,
            attachment_id=0,
            name="summary_race.pdf",
            file_extension="pdf",
            file_size=1024,
            user_id=test_user.id,
            is_active=True,
            source_type="file",
            summary={"status": "queued"},
        )
        test_db.add(doc)
        test_db.commit()
        test_db.refresh(doc)
        return doc

    @pytest.mark.asyncio
    async def test_trigger_document_summary_skips_post_write_if_document_deleted(
        self,
        test_db: Session,
        test_user: User,
        test_document: KnowledgeDocument,
    ) -> None:
        summary_service = get_summary_service(test_db)
        document_id = test_document.id

        async def delete_document_and_return_result(*args, **kwargs):
            (
                test_db.query(KnowledgeDocument)
                .filter(KnowledgeDocument.id == document_id)
                .delete(synchronize_session=False)
            )
            test_db.commit()
            return MagicMock(
                success=True,
                parsed_content={
                    "short_summary": "short",
                    "long_summary": "long",
                    "topics": ["topic"],
                },
                task_id=123,
                error=None,
            )

        with (
            patch.object(
                summary_service,
                "_get_model_config_from_kb",
                return_value={
                    "model_name": "summary-model",
                    "model_namespace": "default",
                    "model_type": "llm",
                },
            ),
            patch.object(
                summary_service,
                "_get_document_content",
                AsyncMock(return_value="document content"),
            ),
            patch.object(
                summary_service,
                "_check_and_trigger_kb_summary",
                AsyncMock(),
            ) as mock_check_and_trigger_kb_summary,
            patch(
                "app.services.knowledge.summary_service.BackgroundChatExecutor"
            ) as mock_executor,
        ):
            mock_instance = MagicMock()
            mock_instance.execute = AsyncMock(
                side_effect=delete_document_and_return_result
            )
            mock_executor.with_short_sessions.return_value = mock_instance

            result = await summary_service.trigger_document_summary(
                document_id,
                test_user.id,
                test_user.user_name,
            )

        assert result is not None
        assert result.success is True
        assert (
            test_db.query(KnowledgeDocument)
            .filter(KnowledgeDocument.id == document_id)
            .first()
            is None
        )
        mock_check_and_trigger_kb_summary.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_trigger_document_summary_handles_deleted_document_in_error_path(
        self,
        test_db: Session,
        test_user: User,
        test_document: KnowledgeDocument,
    ) -> None:
        summary_service = get_summary_service(test_db)
        document_id = test_document.id

        async def delete_document_and_raise(*args, **kwargs):
            (
                test_db.query(KnowledgeDocument)
                .filter(KnowledgeDocument.id == document_id)
                .delete(synchronize_session=False)
            )
            test_db.commit()
            raise RuntimeError("summary generation failed")

        with (
            patch.object(
                summary_service,
                "_get_model_config_from_kb",
                return_value={
                    "model_name": "summary-model",
                    "model_namespace": "default",
                    "model_type": "llm",
                },
            ),
            patch.object(
                summary_service,
                "_get_document_content",
                AsyncMock(return_value="document content"),
            ),
            patch(
                "app.services.knowledge.summary_service.BackgroundChatExecutor"
            ) as mock_executor,
        ):
            mock_instance = MagicMock()
            mock_instance.execute = AsyncMock(side_effect=delete_document_and_raise)
            mock_executor.with_short_sessions.return_value = mock_instance

            result = await summary_service.trigger_document_summary(
                document_id,
                test_user.id,
                test_user.user_name,
            )

        assert result is None
        assert (
            test_db.query(KnowledgeDocument)
            .filter(KnowledgeDocument.id == document_id)
            .first()
            is None
        )

    @pytest.mark.asyncio
    async def test_trigger_document_summary_skips_content_fetch_for_deleted_document(
        self,
        test_db: Session,
        test_user: User,
        test_document: KnowledgeDocument,
    ) -> None:
        summary_service = get_summary_service(test_db)
        document_id = test_document.id
        original_persist_document_summary = summary_service._persist_document_summary
        persist_calls = 0

        def persist_and_delete(document_id_arg: int, summary_data: dict) -> bool:
            nonlocal persist_calls
            result = original_persist_document_summary(document_id_arg, summary_data)
            if persist_calls == 0:
                (
                    test_db.query(KnowledgeDocument)
                    .filter(KnowledgeDocument.id == document_id)
                    .delete(synchronize_session=False)
                )
                test_db.commit()
            persist_calls += 1
            return result

        with (
            patch.object(
                summary_service,
                "_get_model_config_from_kb",
                return_value={
                    "model_name": "summary-model",
                    "model_namespace": "default",
                    "model_type": "llm",
                },
            ),
            patch.object(
                summary_service,
                "_persist_document_summary",
                side_effect=persist_and_delete,
            ),
            patch(
                "app.services.knowledge.summary_service.BackgroundChatExecutor"
            ) as mock_executor,
        ):
            result = await summary_service.trigger_document_summary(
                document_id,
                test_user.id,
                test_user.user_name,
            )

        assert result is None
        assert (
            test_db.query(KnowledgeDocument)
            .filter(KnowledgeDocument.id == document_id)
            .first()
            is None
        )
        mock_executor.assert_not_called()
