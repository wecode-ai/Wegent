"""Ordinary conversion retains the manual actor for subsequent index checks."""

from unittest.mock import MagicMock

import pytest

from app.core.celery_app import celery_app
from app.core.config import settings
from app.models.kind import Kind
from app.models.knowledge import DocumentIndexStatus, KnowledgeDocument
from app.schemas.knowledge import KnowledgeDocumentCreate
from app.services.knowledge.orchestrator import knowledge_orchestrator
from tests.services.knowledge.test_document_attachment_lifecycle import (
    attachment,
    bodies,
)
from tests.utils.retrieval_resources import embedding_model_kind, retriever_kind


@pytest.mark.parametrize("extension", ["pdf", "docx"])
def test_conversion_dispatch_retains_caller_for_index_callback(
    test_db, test_user, bodies, monkeypatch, extension
):
    source = attachment(test_db, test_user.id, bodies)
    source.type_data = {**source.type_data, "file_extension": extension}
    kb = Kind(
        user_id=test_user.id,
        kind="KnowledgeBase",
        name="conversion-caller",
        namespace="default",
        is_active=True,
        json={
            "spec": {
                "retrievalConfig": {
                    "retriever_name": "conversion-storage",
                    "retriever_namespace": "default",
                    "embedding_config": {
                        "model_name": "conversion-embedding",
                        "model_namespace": "default",
                    },
                }
            }
        },
    )
    test_db.add_all(
        [
            kb,
            retriever_kind(test_user.id, "conversion-storage"),
            embedding_model_kind(test_user.id, "conversion-embedding"),
        ]
    )
    test_db.commit()
    send = MagicMock(return_value=MagicMock(id="conversion-task"))
    monkeypatch.setattr(celery_app, "send_task", send)
    monkeypatch.setattr(settings, "KNOWLEDGE_CONVERSION_ENABLED", True)
    monkeypatch.setattr(settings, "KNOWLEDGE_CONVERSION_FILE_TYPES", "pdf,docx")

    result = knowledge_orchestrator.create_document_from_attachment(
        test_db,
        test_user,
        kb.id,
        KnowledgeDocumentCreate(
            attachment_id=source.id, name="manual-conversion", file_extension=extension
        ),
        trigger_summary=False,
    )

    row = test_db.get(KnowledgeDocument, result.id)
    assert row.index_status == DocumentIndexStatus.PENDING_CONVERSION
    payload = send.call_args.kwargs["kwargs"]["index_dispatch_payload"]
    assert payload["caller_user_id"] == test_user.id
    assert payload["user_id"] == test_user.id
