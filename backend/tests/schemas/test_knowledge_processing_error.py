"""Tests for knowledge document processing error responses."""

from datetime import datetime, timezone

from app.schemas.knowledge import KnowledgeDocumentResponse
from app.services.knowledge.processing_errors import map_legacy_conversion_error


def test_document_response_derives_error_and_hides_storage_key() -> None:
    occurred_at = datetime.now(timezone.utc).isoformat()

    response = KnowledgeDocumentResponse.model_validate(
        {
            "id": 1,
            "kind_id": 2,
            "attachment_id": 3,
            "name": "video.mp4",
            "file_extension": "mp4",
            "file_size": 1024,
            "status": "disabled",
            "user_id": 4,
            "is_active": False,
            "index_status": "failed",
            "index_generation": 7,
            "source_type": "file",
            "source_config": {
                "converted_attachment_id": 8,
                "processing_error": {
                    "stage": "conversion",
                    "code": "model_quota_exhausted",
                    "message": "The selected model quota has been exhausted.",
                    "retryable": False,
                    "generation": 7,
                    "occurred_at": occurred_at,
                },
            },
            "folder_id": 0,
            "created_at": occurred_at,
            "updated_at": occurred_at,
        }
    )

    assert response.processing_error is not None
    assert response.processing_error.code == "model_quota_exhausted"
    assert "processing_error" not in response.source_config
    assert response.source_config["converted_attachment_id"] == 8


def test_document_response_preserves_error_during_response_revalidation() -> None:
    """FastAPI revalidates the service model after the storage key is hidden."""
    occurred_at = datetime.now(timezone.utc).isoformat()
    payload = {
        "id": 1,
        "kind_id": 2,
        "attachment_id": 3,
        "name": "document.pdf",
        "file_extension": "pdf",
        "file_size": 1024,
        "status": "disabled",
        "user_id": 4,
        "is_active": False,
        "index_status": "failed",
        "index_generation": 7,
        "source_type": "file",
        "source_config": {
            "processing_error": {
                "stage": "conversion",
                "code": "conversion_service_unavailable",
                "message": "The conversion service could not be reached.",
                "retryable": True,
                "generation": 7,
                "occurred_at": occurred_at,
                "provider": "mineru",
            }
        },
        "folder_id": 0,
        "created_at": occurred_at,
        "updated_at": occurred_at,
    }

    service_response = KnowledgeDocumentResponse.model_validate(payload)
    api_response = KnowledgeDocumentResponse.model_validate(
        service_response.model_dump()
    )

    assert api_response.processing_error is not None
    assert api_response.processing_error.code == "conversion_service_unavailable"
    assert api_response.processing_error.provider == "mineru"
    assert "processing_error" not in api_response.source_config


def test_document_response_ignores_error_from_stale_generation() -> None:
    occurred_at = datetime.now(timezone.utc).isoformat()
    payload = {
        "id": 1,
        "kind_id": 2,
        "attachment_id": 3,
        "name": "document.pdf",
        "file_extension": "pdf",
        "file_size": 1024,
        "status": "disabled",
        "user_id": 4,
        "is_active": False,
        "index_status": "failed",
        "index_generation": 8,
        "source_type": "file",
        "source_config": {
            "processing_error": {
                "stage": "indexing",
                "code": "indexing_failed",
                "message": "Document indexing failed.",
                "retryable": True,
                "generation": 7,
                "occurred_at": occurred_at,
            }
        },
        "folder_id": 0,
        "created_at": occurred_at,
        "updated_at": occurred_at,
    }

    response = KnowledgeDocumentResponse.model_validate(payload)

    assert response.processing_error is None


def test_legacy_read_error_maps_to_conversion_service_unavailable() -> None:
    error = map_legacy_conversion_error("ReadError:", generation=3)

    assert error.code == "conversion_service_unavailable"
    assert error.retryable is True
