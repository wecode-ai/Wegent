# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Service tests for single external document import."""

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest
from sqlalchemy import delete, event
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.knowledge import (
    DocumentIndexStatus,
    DocumentSourceType,
    DocumentStatus,
    KnowledgeDocument,
    KnowledgeDocumentExternalSource,
)
from app.models.subtask_context import SubtaskContext
from app.models.user import User
from app.schemas.knowledge import (
    KnowledgeDocumentCreate,
    KnowledgeDocumentUpdate,
)
from app.services.knowledge.external_document_import import (
    external_document_import_service,
    run_external_document_import,
)
from app.services.knowledge.external_document_providers import (
    ExternalDocumentContent,
    ExternalDocumentFetchError,
    ExternalDocumentImportError,
    ExternalSourceUnavailableError,
    get_external_document_provider,
)
from app.services.knowledge.knowledge_service import KnowledgeService

from .conftest import create_external_import_kb as _create_kb


class TestRunExternalDocumentImport:
    def _create_placeholder(
        self, test_db: Session, test_user: User
    ) -> KnowledgeDocument:
        kb_id = _create_kb(test_db, test_user.id, "external-import-run-kb")
        document = KnowledgeDocument(
            kind_id=kb_id,
            attachment_id=0,
            name="Run Doc",
            file_extension="md",
            file_size=0,
            user_id=test_user.id,
            source_type=DocumentSourceType.EXTERNAL.value,
            source_config={"external": {"provider": "dingtalk"}},
            external_source=KnowledgeDocumentExternalSource(
                kind_id=kb_id,
                external_provider="dingtalk",
                external_resource_id="h" * 32,
            ),
            index_status=DocumentIndexStatus.QUEUED,
        )
        test_db.add(document)
        test_db.commit()
        test_db.refresh(document)
        return document

    def test_deleted_during_upload_cleans_attachment_and_exits(
        self,
        test_db: Session,
        test_user: User,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        document = self._create_placeholder(test_db, test_user)
        document_id = document.id
        monkeypatch.setattr(test_db, "expire_on_commit", True)
        monkeypatch.setattr(
            get_external_document_provider("dingtalk"),
            "fetch_content",
            AsyncMock(
                return_value=ExternalDocumentContent(
                    name="Deleted during upload", file_extension="md", content=b"body"
                )
            ),
        )
        uploaded_ids: list[int] = []

        def delete_document_during_upload(mapper, connection, attachment) -> None:
            uploaded_ids.append(attachment.id)
            # Bypass the worker identity map, as a concurrent deletion would.
            connection.execute(
                delete(KnowledgeDocument).where(KnowledgeDocument.id == document_id)
            )

        event.listen(SubtaskContext, "after_insert", delete_document_during_upload)
        try:
            run_external_document_import(test_db, document, test_user, generation=0)
        finally:
            event.remove(SubtaskContext, "after_insert", delete_document_during_upload)

        assert test_db.get(KnowledgeDocument, document_id) is None
        assert len(uploaded_ids) == 1
        assert test_db.get(SubtaskContext, uploaded_ids[0]) is None

    def test_recovered_source_stays_accessible_when_indexing_fails(
        self,
        test_db: Session,
        test_user: User,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        from app.services.knowledge.index_state_machine import (
            mark_document_index_failed,
        )

        document = self._create_placeholder(test_db, test_user)
        document_id = document.id
        document.update_external_source_config(
            status="inaccessible",
            last_error="Source was unavailable",
            last_success_at="2026-08-01T00:00:00+00:00",
        )
        kb = test_db.get(Kind, document.kind_id)
        kb.json = {
            **kb.json,
            "spec": {
                **kb.json["spec"],
                "retrievalConfig": {
                    "retriever_name": "test-retriever",
                    "embedding_config": {"model_name": "test-embedding"},
                },
            },
        }
        test_db.commit()
        monkeypatch.setattr(test_db, "expire_on_commit", True)
        monkeypatch.setattr(
            get_external_document_provider("dingtalk"),
            "fetch_content",
            AsyncMock(
                return_value=ExternalDocumentContent(
                    name="Recovered source", file_extension="md", content=b"new body"
                )
            ),
        )
        monkeypatch.setattr(
            "app.tasks.knowledge_tasks.index_document_task.delay",
            MagicMock(return_value=SimpleNamespace(id="index-task")),
        )

        run_external_document_import(test_db, document, test_user, generation=0)
        assert mark_document_index_failed(
            test_db, document_id, document.index_generation
        )

        current = KnowledgeService.get_document(test_db, document_id, test_user.id)
        assert current.index_status == DocumentIndexStatus.FAILED
        assert current.external_source_config["status"] == "accessible"
        assert "last_error" not in current.external_source_config
        assert (
            current.external_source_config["last_success_at"]
            == "2026-08-01T00:00:00+00:00"
        )
        assert (
            test_db.get(SubtaskContext, current.attachment_id).extracted_text
            == "new body"
        )

    def test_attaches_content_through_orchestrator(
        self,
        test_db: Session,
        test_user: User,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        document = self._create_placeholder(test_db, test_user)
        content = ExternalDocumentContent(
            name="Run Doc",
            file_extension="md",
            content=b"# Run Doc",
            metadata={"provider": "dingtalk"},
        )
        provider = SimpleNamespace(
            fetch_content=AsyncMock(return_value=content),
        )
        attached: dict = {}

        def fake_attach(**kwargs):
            attached.update(kwargs)
            return {"scheduled": True}

        monkeypatch.setattr(
            "app.services.knowledge.external_document_import"
            ".get_external_document_provider",
            lambda provider_id: provider,
        )
        monkeypatch.setattr(
            "app.services.knowledge.orchestrator.knowledge_orchestrator"
            ".attach_external_document_content",
            fake_attach,
        )

        run_external_document_import(test_db, document, test_user, generation=0)

        provider.fetch_content.assert_awaited_once_with(test_db, test_user, "h" * 32)
        assert attached["document"].id == document.id
        assert attached["content"] is content
        assert attached["generation"] == 0

    @pytest.mark.parametrize("previous_conversion", [None, 9876])
    def test_imported_docx_is_sent_to_converter(
        self,
        test_db: Session,
        test_user: User,
        monkeypatch: pytest.MonkeyPatch,
        previous_conversion: int | None,
    ) -> None:
        from app.core.config import settings

        monkeypatch.setattr(settings, "KNOWLEDGE_CONVERSION_ENABLED", True)
        monkeypatch.setattr(settings, "KNOWLEDGE_CONVERSION_FILE_TYPES", "docx")
        document = self._create_placeholder(test_db, test_user)
        document.converted_attachment_id = previous_conversion
        kb = test_db.get(Kind, document.kind_id)
        kb.json = {
            **kb.json,
            "spec": {
                **kb.json["spec"],
                "retrievalConfig": {
                    "retriever_name": "test-retriever",
                    "embedding_config": {"model_name": "test-embedding"},
                },
            },
        }
        test_db.commit()
        content = ExternalDocumentContent(
            name="External Word Document", file_extension="docx", content=b"word bytes"
        )
        monkeypatch.setattr(
            get_external_document_provider("dingtalk"),
            "fetch_content",
            AsyncMock(return_value=content),
        )
        monkeypatch.setattr(
            "app.services.context.context_service.upload_attachment",
            MagicMock(return_value=(SimpleNamespace(id=4321), None)),
        )
        convert = MagicMock(return_value=SimpleNamespace(id="conversion-task"))
        index = MagicMock(return_value=SimpleNamespace(id="index-task"))
        monkeypatch.setattr("app.core.celery_app.celery_app.send_task", convert)
        monkeypatch.setattr(
            "app.tasks.knowledge_tasks.index_document_task.delay", index
        )

        run_external_document_import(test_db, document, test_user, generation=0)

        test_db.refresh(document)
        assert document.file_extension == "docx"
        assert document.index_status == DocumentIndexStatus.PENDING_CONVERSION
        assert document.converted_attachment_id is None
        assert document.name == "Run Doc"
        assert convert.call_args.args == ("knowledge_doc_converter.convert_document",)
        assert convert.call_args.kwargs["kwargs"]["file_extension"] == "docx"
        assert convert.call_args.kwargs["kwargs"]["attachment_id"] == 4321
        index.assert_not_called()

    def test_fetch_failure_marks_document_failed(
        self,
        test_db: Session,
        test_user: User,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        document = self._create_placeholder(test_db, test_user)
        provider = SimpleNamespace(
            fetch_content=AsyncMock(side_effect=ExternalDocumentFetchError("boom")),
        )
        monkeypatch.setattr(
            "app.services.knowledge.external_document_import"
            ".get_external_document_provider",
            lambda provider_id: provider,
        )

        run_external_document_import(test_db, document, test_user, generation=0)

        test_db.refresh(document)
        assert document.index_status == DocumentIndexStatus.FAILED
        error = document.processing_error_payload
        assert error is not None
        assert error["code"] == "external_import_failed"
        assert error["retryable"] is True
        assert error["generation"] == 0

    def test_new_attempt_after_attachment_landing_is_not_replaced_by_old_handoff(
        self, test_db: Session, test_user: User, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        from app.services.knowledge.orchestrator import knowledge_orchestrator

        document = self._create_placeholder(test_db, test_user)
        document.attachment_id = 777
        kb = test_db.get(Kind, document.kind_id)
        kb.json = {
            **kb.json,
            "spec": {
                **kb.json["spec"],
                "retrievalConfig": {
                    "retriever_name": "test-retriever",
                    "embedding_config": {"model_name": "test-embedding"},
                },
            },
        }
        test_db.commit()
        monkeypatch.setattr(
            "app.services.context.context_service.upload_attachment",
            MagicMock(return_value=(SimpleNamespace(id=4321), None)),
        )

        def delete_previous_attachment(**kwargs):
            # A new attempt wins while storage cleanup is in flight.
            document.index_generation = 4
            document.index_status = DocumentIndexStatus.QUEUED
            test_db.commit()
            return True

        monkeypatch.setattr(
            "app.services.context.context_service.delete_context",
            delete_previous_attachment,
        )
        dispatch = MagicMock()
        monkeypatch.setattr(
            "app.tasks.knowledge_tasks.index_document_task.delay", dispatch
        )

        result = knowledge_orchestrator.attach_external_document_content(
            test_db,
            document,
            test_user,
            ExternalDocumentContent(name="Old", file_extension="md", content=b"old"),
            generation=0,
        )

        assert result["scheduled"] is False
        assert result["reason"] == "stale_generation"
        dispatch.assert_not_called()
        test_db.refresh(document)
        assert document.index_generation == 4
        assert document.index_status == DocumentIndexStatus.QUEUED
        assert document.processing_error_payload is None

    def test_unsupported_provider_marks_document_failed(
        self,
        test_db: Session,
        test_user: User,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        document = self._create_placeholder(test_db, test_user)
        document.external_source.external_provider = "gone"
        document.external_source.external_resource_id = "h" * 32
        test_db.commit()

        run_external_document_import(test_db, document, test_user, generation=0)

        test_db.refresh(document)
        assert document.index_status == DocumentIndexStatus.FAILED
        assert document.processing_error_payload["code"] == "external_import_failed"

    def test_stale_generation_failure_is_ignored(
        self,
        test_db: Session,
        test_user: User,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        document = self._create_placeholder(test_db, test_user)
        # A newer attempt already superseded this run's generation.
        document.index_generation = 2
        document.index_status = DocumentIndexStatus.INDEXING
        test_db.commit()
        provider = SimpleNamespace(
            fetch_content=AsyncMock(side_effect=ExternalDocumentFetchError("boom")),
        )
        monkeypatch.setattr(
            "app.services.knowledge.external_document_import"
            ".get_external_document_provider",
            lambda provider_id: provider,
        )

        run_external_document_import(test_db, document, test_user, generation=1)

        test_db.refresh(document)
        assert document.index_status == DocumentIndexStatus.INDEXING
        assert document.index_generation == 2
        assert document.processing_error_payload is None

    def test_lost_write_stands_down_without_marking_failed(
        self,
        test_db: Session,
        test_user: User,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        from app.services.knowledge.external_document_providers import (
            ExternalImportLostWriteError,
        )

        document = self._create_placeholder(test_db, test_user)
        provider = SimpleNamespace(
            fetch_content=AsyncMock(
                return_value=ExternalDocumentContent(
                    name="Run Doc",
                    file_extension="md",
                    content=b"# Run Doc",
                    metadata={},
                )
            ),
        )
        monkeypatch.setattr(
            "app.services.knowledge.external_document_import"
            ".get_external_document_provider",
            lambda provider_id: provider,
        )
        monkeypatch.setattr(
            "app.services.knowledge.orchestrator.knowledge_orchestrator"
            ".attach_external_document_content",
            MagicMock(side_effect=ExternalImportLostWriteError("superseded")),
        )

        run_external_document_import(test_db, document, test_user, generation=0)

        test_db.refresh(document)
        assert document.index_status == DocumentIndexStatus.QUEUED
        assert document.processing_error_payload is None

    def test_single_failure_does_not_affect_sibling_documents(
        self,
        test_db: Session,
        test_user: User,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        kb_id = _create_kb(test_db, test_user.id, "batch-independence-kb")
        failing = KnowledgeDocument(
            kind_id=kb_id,
            attachment_id=0,
            name="Failing Doc",
            file_extension="md",
            file_size=0,
            user_id=test_user.id,
            source_type=DocumentSourceType.EXTERNAL.value,
            source_config={"external": {"provider": "dingtalk"}},
            external_source=KnowledgeDocumentExternalSource(
                kind_id=kb_id,
                external_provider="dingtalk",
                external_resource_id="r" * 32,
            ),
            index_status=DocumentIndexStatus.QUEUED,
        )
        succeeding = KnowledgeDocument(
            kind_id=kb_id,
            attachment_id=0,
            name="Succeeding Doc",
            file_extension="md",
            file_size=0,
            user_id=test_user.id,
            source_type=DocumentSourceType.EXTERNAL.value,
            source_config={"external": {"provider": "dingtalk"}},
            external_source=KnowledgeDocumentExternalSource(
                kind_id=kb_id,
                external_provider="dingtalk",
                external_resource_id="s" * 32,
            ),
            index_status=DocumentIndexStatus.QUEUED,
        )
        test_db.add_all([failing, succeeding])
        test_db.commit()

        def fake_fetch(db, user, resource_id):
            if resource_id == "r" * 32:
                raise ExternalDocumentFetchError("boom")
            return ExternalDocumentContent(
                name="Succeeding Doc",
                file_extension="md",
                content=b"# ok",
                metadata={},
            )

        provider = SimpleNamespace(fetch_content=AsyncMock(side_effect=fake_fetch))
        attached: list[int] = []

        def fake_attach(**kwargs):
            attached.append(kwargs["document"].id)
            return {"scheduled": True}

        monkeypatch.setattr(
            "app.services.knowledge.external_document_import"
            ".get_external_document_provider",
            lambda provider_id: provider,
        )
        monkeypatch.setattr(
            "app.services.knowledge.orchestrator.knowledge_orchestrator"
            ".attach_external_document_content",
            fake_attach,
        )

        run_external_document_import(test_db, failing, test_user, generation=0)
        run_external_document_import(test_db, succeeding, test_user, generation=0)

        test_db.refresh(failing)
        test_db.refresh(succeeding)
        assert failing.index_status == DocumentIndexStatus.FAILED
        assert failing.processing_error_payload["code"] == "external_import_failed"
        assert succeeding.index_status == DocumentIndexStatus.QUEUED
        assert succeeding.processing_error_payload is None
        assert attached == [succeeding.id]


class TestRetryDocumentImport:
    def _create_failed_document(
        self,
        test_db: Session,
        test_user: User,
        *,
        index_status: DocumentIndexStatus = DocumentIndexStatus.FAILED,
        external: bool = True,
    ) -> KnowledgeDocument:
        kb_id = _create_kb(test_db, test_user.id, "retry-external-kb")
        document = KnowledgeDocument(
            kind_id=kb_id,
            attachment_id=0,
            name="Retry Doc",
            file_extension="md",
            file_size=0,
            user_id=test_user.id,
            source_type=DocumentSourceType.EXTERNAL.value,
            source_config={"external": {"provider": "dingtalk"}},
            external_source=(
                KnowledgeDocumentExternalSource(
                    kind_id=kb_id,
                    external_provider="dingtalk",
                    external_resource_id="t" * 32,
                )
                if external
                else None
            ),
            index_status=index_status,
            index_generation=0,
        )
        document.set_processing_error_payload(
            {
                "stage": "system",
                "code": "external_import_failed",
                "message": "failed",
                "retryable": True,
                "generation": 0,
                "occurred_at": "2026-08-26T00:00:00Z",
            }
        )
        test_db.add(document)
        test_db.commit()
        test_db.refresh(document)
        return document

    def test_reuses_same_document_and_redispatches(
        self,
        test_db: Session,
        test_user: User,
        dispatched: list[int],
    ) -> None:
        document = self._create_failed_document(test_db, test_user)

        result = external_document_import_service.retry_document_import(
            db=test_db, user=test_user, document_id=document.id
        )

        assert result.id == document.id
        assert dispatched == [document.id]
        test_db.refresh(document)
        assert document.index_status == DocumentIndexStatus.QUEUED
        assert document.index_generation == 1
        assert document.processing_error_payload is None
        # Retry reuses the record instead of creating a copy.
        assert test_db.query(KnowledgeDocument).count() == 1

    def test_rejects_retry_while_import_in_progress(
        self,
        test_db: Session,
        test_user: User,
        dispatched: list[int],
    ) -> None:
        document = self._create_failed_document(
            test_db, test_user, index_status=DocumentIndexStatus.QUEUED
        )

        with pytest.raises(ExternalDocumentImportError) as exc_info:
            external_document_import_service.retry_document_import(
                db=test_db, user=test_user, document_id=document.id
            )

        assert exc_info.value.status_code == 409
        assert dispatched == []
        test_db.refresh(document)
        assert document.index_generation == 0

    def test_rejects_retry_of_successful_import(
        self,
        test_db: Session,
        test_user: User,
        dispatched: list[int],
    ) -> None:
        document = self._create_failed_document(
            test_db, test_user, index_status=DocumentIndexStatus.SUCCESS
        )

        with pytest.raises(ExternalDocumentImportError) as exc_info:
            external_document_import_service.retry_document_import(
                db=test_db, user=test_user, document_id=document.id
            )

        assert exc_info.value.status_code == 409
        assert dispatched == []

    def test_rejects_non_external_document(
        self,
        test_db: Session,
        test_user: User,
    ) -> None:
        document = self._create_failed_document(test_db, test_user, external=False)

        with pytest.raises(ExternalDocumentImportError) as exc_info:
            external_document_import_service.retry_document_import(
                db=test_db, user=test_user, document_id=document.id
            )

        assert exc_info.value.status_code == 400

    def test_rejects_missing_document(
        self,
        test_db: Session,
        test_user: User,
    ) -> None:
        with pytest.raises(ExternalDocumentImportError) as exc_info:
            external_document_import_service.retry_document_import(
                db=test_db, user=test_user, document_id=999999
            )

        assert exc_info.value.status_code == 404

    def test_rejects_without_manage_permission(
        self,
        test_db: Session,
        test_user: User,
        monkeypatch: pytest.MonkeyPatch,
        dispatched: list[int],
    ) -> None:
        document = self._create_failed_document(test_db, test_user)
        monkeypatch.setattr(
            KnowledgeService,
            "can_manage_knowledge_base_documents",
            staticmethod(lambda db, kb_id, user_id: False),
        )

        with pytest.raises(ExternalDocumentImportError) as exc_info:
            external_document_import_service.retry_document_import(
                db=test_db, user=test_user, document_id=document.id
            )

        assert exc_info.value.status_code == 403
        assert dispatched == []


class TestExternalDocumentPreviewAndEnableGuards:
    def _create_document(
        self,
        test_db: Session,
        test_user: User,
        *,
        attachment_id: int = 0,
        index_status: DocumentIndexStatus,
        is_active: bool = False,
        external: bool = True,
    ) -> KnowledgeDocument:
        kb_id = _create_kb(test_db, test_user.id, "guards-external-kb")
        document = KnowledgeDocument(
            kind_id=kb_id,
            attachment_id=attachment_id,
            name="Guard Doc",
            file_extension="md",
            file_size=10,
            user_id=test_user.id,
            source_type=(DocumentSourceType.EXTERNAL.value if external else "file"),
            source_config={"external": {"provider": "dingtalk"}},
            external_source=(
                KnowledgeDocumentExternalSource(
                    kind_id=kb_id,
                    external_provider="dingtalk",
                    external_resource_id="u" * 32,
                )
                if external
                else None
            ),
            index_status=index_status,
            is_active=is_active,
        )
        test_db.add(document)
        test_db.commit()
        test_db.refresh(document)
        return document

    def test_placeholder_cannot_be_previewed(
        self, test_db: Session, test_user: User
    ) -> None:
        from app.services.knowledge.orchestrator import knowledge_orchestrator

        document = self._create_document(
            test_db, test_user, index_status=DocumentIndexStatus.QUEUED
        )

        with pytest.raises(ValueError, match="not ready"):
            knowledge_orchestrator.read_document_content(
                db=test_db, user=test_user, document_id=document.id
            )

    def test_missing_attachment_cannot_be_previewed(
        self, test_db: Session, test_user: User
    ) -> None:
        from app.services.knowledge.orchestrator import knowledge_orchestrator

        document = self._create_document(
            test_db,
            test_user,
            attachment_id=99,
            index_status=DocumentIndexStatus.FAILED,
            is_active=False,
        )

        with pytest.raises(ValueError, match="not ready"):
            knowledge_orchestrator.read_document_content(
                db=test_db, user=test_user, document_id=document.id
            )

    def test_indexed_external_document_passes_preview_guard(
        self, test_db: Session, test_user: User
    ) -> None:
        from app.services.knowledge.orchestrator import knowledge_orchestrator

        document = self._create_document(
            test_db,
            test_user,
            attachment_id=99,
            index_status=DocumentIndexStatus.SUCCESS,
            is_active=True,
        )

        # Guard passes; the read itself is exercised by the read-service tests.
        knowledge_orchestrator._assert_external_document_previewable(document)

    def test_failed_reindex_of_active_document_stays_previewable(
        self, test_db: Session, test_user: User
    ) -> None:
        from app.services.knowledge.orchestrator import knowledge_orchestrator

        document = self._create_document(
            test_db,
            test_user,
            attachment_id=99,
            index_status=DocumentIndexStatus.FAILED,
            is_active=True,
        )

        knowledge_orchestrator._assert_external_document_previewable(document)

    def test_non_external_failed_document_unchanged(
        self, test_db: Session, test_user: User
    ) -> None:
        from app.services.knowledge.orchestrator import knowledge_orchestrator

        document = self._create_document(
            test_db,
            test_user,
            attachment_id=99,
            index_status=DocumentIndexStatus.FAILED,
            external=False,
        )

        knowledge_orchestrator._assert_external_document_previewable(document)

    def test_failed_import_cannot_be_enabled(
        self, test_db: Session, test_user: User
    ) -> None:
        document = self._create_document(
            test_db,
            test_user,
            attachment_id=99,
            index_status=DocumentIndexStatus.FAILED,
        )

        with pytest.raises(ValueError):
            KnowledgeService.update_document(
                db=test_db,
                document_id=document.id,
                user_id=test_user.id,
                data=KnowledgeDocumentUpdate(status=DocumentStatus.ENABLED),
            )

    def test_successful_import_can_be_enabled(
        self, test_db: Session, test_user: User
    ) -> None:
        document = self._create_document(
            test_db,
            test_user,
            attachment_id=99,
            index_status=DocumentIndexStatus.SUCCESS,
            is_active=True,
        )

        updated = KnowledgeService.update_document(
            db=test_db,
            document_id=document.id,
            user_id=test_user.id,
            data=KnowledgeDocumentUpdate(status=DocumentStatus.ENABLED),
        )

        assert updated is not None
        assert updated.status == DocumentStatus.ENABLED

    def test_failed_reindex_of_active_document_can_be_enabled(
        self, test_db: Session, test_user: User
    ) -> None:
        document = self._create_document(
            test_db,
            test_user,
            attachment_id=99,
            index_status=DocumentIndexStatus.FAILED,
            is_active=True,
        )

        updated = KnowledgeService.update_document(
            db=test_db,
            document_id=document.id,
            user_id=test_user.id,
            data=KnowledgeDocumentUpdate(status=DocumentStatus.ENABLED),
        )

        assert updated is not None
        assert updated.status == DocumentStatus.ENABLED
