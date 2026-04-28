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
from app.services.knowledge import SummaryService, get_summary_service


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
            mock_executor.return_value = mock_instance

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
            mock_executor.return_value = mock_instance

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
            mock_executor.return_value = mock_instance

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
