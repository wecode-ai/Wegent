from collections.abc import Generator
from types import SimpleNamespace
from typing import Any
from unittest.mock import MagicMock

import pytest
from pytest_mock import MockerFixture

from app.services.knowledge.document_read_service import DocumentReadService
from app.services.knowledge.orchestrator import KnowledgeOrchestrator
from shared.event_reporting import register_event_receiver


@pytest.fixture
def read_events() -> Generator[list[dict[str, Any]], None, None]:
    events: list[dict[str, Any]] = []

    class Receiver:
        def accepts(self, event_type: str) -> bool:
            return event_type == "knowledge.document.read.finished"

        def observation_limit(self, event_type: str) -> int:
            return 0

        def receive(self, event: dict[str, Any]) -> None:
            events.append(event)

    register_event_receiver(Receiver())
    yield events
    register_event_receiver(None)


def test_batch_read_reports_every_result(
    mocker: MockerFixture, read_events: list[dict[str, Any]]
) -> None:
    service = DocumentReadService()
    documents = {
        i: SimpleNamespace(id=i, kind_id=1, attachment_id=i, name="doc")
        for i in range(1, 151)
    }
    mocker.patch.object(service, "_load_documents", return_value=documents)
    mocker.patch.object(
        service,
        "_load_attachment_contexts",
        return_value={i: SimpleNamespace(extracted_text="text") for i in documents},
    )
    results = service.read_documents(
        MagicMock(), document_ids=list(documents), user_id=7
    )
    assert len(results) == 150
    assert [event["document_id"] for event in read_events] == list(documents)


@pytest.mark.parametrize(
    "source_type, text, expected_status",
    [
        ("external", "", "failed"),
        ("file", "body", "success"),
    ],
)
def test_single_read_records_final_outcome_and_actor(
    mocker: MockerFixture,
    read_events: list[dict[str, Any]],
    source_type: str,
    text: str,
    expected_status: str,
) -> None:
    document = SimpleNamespace(
        id=9,
        kind_id=1,
        attachment_id=1,
        name="doc",
        source_type=source_type,
        index_status="success",
    )
    orchestrator = KnowledgeOrchestrator()
    mocker.patch.object(
        orchestrator, "_get_document_with_access_or_raise", return_value=document
    )
    mocker.patch.object(
        DocumentReadService, "_load_documents", return_value={9: document}
    )
    mocker.patch.object(
        DocumentReadService,
        "_load_attachment_contexts",
        return_value={1: SimpleNamespace(extracted_text=text)},
    )
    user = SimpleNamespace(id=7)
    if expected_status == "failed":
        with pytest.raises(ValueError, match="not ready"):
            orchestrator.read_document_content(
                MagicMock(), user, 9, entrypoint="openapi"
            )
    else:
        assert (
            orchestrator.read_document_content(
                MagicMock(), user, 9, entrypoint="openapi"
            ).content
            == "body"
        )
    assert len(read_events) == 1
    event = read_events[0]
    assert event["status"] == expected_status
    assert event["data"]["user_id"] == event["data"]["actor_user_id"] == 7
    assert event["data"]["entrypoint"] == "openapi"


def test_openapi_document_read_passes_its_entrypoint(mocker: MockerFixture) -> None:
    from app.api.endpoints.knowledge_open import get_document_content_open

    read = mocker.patch(
        "app.api.endpoints.knowledge_open.knowledge_orchestrator.read_document_content"
    )
    get_document_content_open(
        document_id=9,
        offset=0,
        limit=10,
        auth_context=SimpleNamespace(user=SimpleNamespace(id=7)),
        db=MagicMock(),
    )
    assert read.call_args.kwargs["entrypoint"] == "openapi"


def test_external_mcp_document_read_reports_caller(
    mocker: MockerFixture, read_events: list[dict[str, Any]]
) -> None:
    from app.mcp_server.tools.knowledge_external import _get_document_content_sync

    document = SimpleNamespace(
        id=9, kind_id=1, attachment_id=1, name="doc", index_status="success"
    )
    mocker.patch(
        "app.mcp_server.tools.knowledge_external.SessionLocal", return_value=MagicMock()
    )
    mocker.patch(
        "app.mcp_server.tools.knowledge_external.get_document_access_or_raise",
        return_value=SimpleNamespace(knowledge_base_id=1, document=document),
    )
    mocker.patch.object(
        DocumentReadService, "_load_documents", return_value={9: document}
    )
    mocker.patch.object(
        DocumentReadService,
        "_load_attachment_contexts",
        return_value={1: SimpleNamespace(extracted_text="body")},
    )
    result = _get_document_content_sync(user_id=7, document_id=9, offset=0, limit=10)
    assert '"content":"body"' in result
    assert len(read_events) == 1
    assert read_events[0]["data"]["actor_user_id"] == 7
    assert read_events[0]["data"]["effective_reader_id"] == 7
    assert read_events[0]["data"]["entrypoint"] == "mcp"


def test_external_mcp_serialization_failure_is_not_reported_as_success(
    mocker: MockerFixture, read_events: list[dict[str, Any]]
) -> None:
    from app.mcp_server.tools.knowledge_external import _get_document_content_sync

    document = SimpleNamespace(
        id=9, kind_id=1, attachment_id=1, name="doc", index_status="success"
    )
    mocker.patch(
        "app.mcp_server.tools.knowledge_external.SessionLocal", return_value=MagicMock()
    )
    mocker.patch(
        "app.mcp_server.tools.knowledge_external.get_document_access_or_raise",
        return_value=SimpleNamespace(knowledge_base_id=1, document=document),
    )
    mocker.patch.object(
        DocumentReadService, "_load_documents", return_value={9: document}
    )
    mocker.patch.object(
        DocumentReadService,
        "_load_attachment_contexts",
        return_value={1: SimpleNamespace(extracted_text="body")},
    )
    mocker.patch(
        "app.mcp_server.tools.knowledge_external.ExternalDocumentContentResponse",
        side_effect=ValueError("invalid response"),
    )
    result = _get_document_content_sync(user_id=7, document_id=9, offset=0, limit=10)
    assert "internal_error" in result
    assert [event["status"] for event in read_events] == ["failed"]
