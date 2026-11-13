from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from app.api.endpoints.knowledge_open import create_document_open
from app.schemas.knowledge import KnowledgeDocumentCreateV1
from app.services.context import context_service
from app.services.knowledge.orchestrator import KnowledgeOrchestrator


@pytest.mark.asyncio
async def test_open_web_creation_passes_openapi_trigger(mocker):
    document = SimpleNamespace(id=3)
    create = mocker.patch(
        "app.api.endpoints.knowledge_open.knowledge_orchestrator.create_web_document",
        new_callable=AsyncMock,
        return_value={"success": True, "document": document},
    )
    await create_document_open(
        KnowledgeDocumentCreateV1(
            knowledge_base_id=1,
            name="web",
            source_type="web",
            url="https://example.com",
        ),
        auth_context=SimpleNamespace(user=SimpleNamespace(id=7)),
        db=MagicMock(),
    )
    assert create.await_args.kwargs["trigger"] == "openapi"


@pytest.mark.asyncio
async def test_web_creation_attributes_document_and_index_dispatch(mocker):
    orchestrator = KnowledgeOrchestrator()
    kb, user, db = MagicMock(), SimpleNamespace(id=7), MagicMock()
    document = SimpleNamespace(id=3)
    mocker.patch(
        "app.services.knowledge.orchestrator.KnowledgeService.get_knowledge_base",
        return_value=(kb, True),
    )
    mocker.patch(
        "app.services.knowledge.orchestrator.KnowledgeService.can_manage_knowledge_base_documents",
        return_value=True,
    )
    create = mocker.patch(
        "app.services.knowledge.orchestrator.KnowledgeService.create_document",
        return_value=document,
    )
    schedule = mocker.patch.object(orchestrator, "_schedule_indexing_celery")
    mocker.patch(
        "app.services.knowledge.orchestrator.KnowledgeDocumentResponse.model_validate",
        return_value=document,
    )
    mocker.patch.object(
        context_service, "upload_attachment", return_value=(SimpleNamespace(id=9), None)
    )
    scraper = SimpleNamespace(
        scrape_url=AsyncMock(
            return_value=SimpleNamespace(
                success=True,
                title="title",
                content="body",
                url="https://example.com",
                scraped_at=datetime.now(timezone.utc),
                description=None,
            )
        )
    )
    mocker.patch(
        "app.services.web_scraper.get_web_scraper_service", return_value=scraper
    )
    await orchestrator.create_web_document(
        db, user, "https://example.com", 1, trigger="openapi"
    )
    assert create.call_args.kwargs["trigger"] == "openapi"
    assert schedule.call_args.kwargs["trigger"] == "openapi"
