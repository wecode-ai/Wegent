import pytest

from app.schemas.knowledge import KnowledgeDocumentResponse
from app.services.knowledge.splitter_config import (
    normalize_splitter_config,
    serialize_splitter_config,
)


def test_normalize_old_smart_config_to_flat_file_aware() -> None:
    normalized = normalize_splitter_config({"type": "smart"})

    assert normalized.chunk_strategy == "flat"
    assert normalized.format_enhancement == "file_aware"
    assert normalized.flat_config is not None
    assert normalized.flat_config.chunk_size == 1024
    assert normalized.flat_config.chunk_overlap == 50
    assert normalized.markdown_enhancement.enabled is True
    assert normalized.legacy_type == "smart"


def test_normalize_old_sentence_config_to_flat_without_format_enhancement() -> None:
    normalized = normalize_splitter_config(
        {
            "type": "sentence",
            "chunk_size": 512,
            "chunk_overlap": 64,
            "separator": "\n",
        }
    )

    assert normalized.chunk_strategy == "flat"
    assert normalized.format_enhancement == "none"
    assert normalized.flat_config is not None
    assert normalized.flat_config.chunk_size == 512
    assert normalized.flat_config.chunk_overlap == 64
    assert normalized.flat_config.separator == "\n"
    assert normalized.markdown_enhancement.enabled is False
    assert normalized.legacy_type == "sentence"


def test_serialize_normalized_config_round_trips() -> None:
    payload = {
        "chunk_strategy": "flat",
        "format_enhancement": "file_aware",
        "flat_config": {
            "chunk_size": 2048,
            "chunk_overlap": 80,
            "separator": "\n\n",
        },
        "markdown_enhancement": {"enabled": True},
    }

    normalized = normalize_splitter_config(payload)

    assert serialize_splitter_config(normalized) == payload


def test_knowledge_document_response_normalizes_legacy_splitter_config() -> None:
    response = KnowledgeDocumentResponse.model_validate(
        {
            "id": 1,
            "kind_id": 2,
            "attachment_id": 3,
            "name": "notes.md",
            "file_extension": ".md",
            "file_size": 10,
            "status": "enabled",
            "user_id": 7,
            "is_active": True,
            "index_status": "success",
            "index_generation": 1,
            "splitter_config": {"type": "smart"},
            "source_type": "file",
            "source_config": {},
            "created_at": "2026-04-10T00:00:00Z",
            "updated_at": "2026-04-10T00:00:00Z",
        }
    )

    assert response.splitter_config is not None
    assert response.splitter_config.chunk_strategy == "flat"
    assert response.splitter_config.format_enhancement == "file_aware"
    assert response.splitter_config.markdown_enhancement.enabled is True


def test_knowledge_document_response_normalizes_empty_splitter_config() -> None:
    response = KnowledgeDocumentResponse.model_validate(
        {
            "id": 1,
            "kind_id": 2,
            "attachment_id": 3,
            "name": "notes.md",
            "file_extension": ".md",
            "file_size": 10,
            "status": "enabled",
            "user_id": 7,
            "is_active": True,
            "index_status": "success",
            "index_generation": 1,
            "splitter_config": {},
            "source_type": "file",
            "source_config": {},
            "created_at": "2026-04-10T00:00:00Z",
            "updated_at": "2026-04-10T00:00:00Z",
        }
    )

    assert response.splitter_config is not None
    assert response.splitter_config.chunk_strategy == "flat"
    assert response.splitter_config.format_enhancement == "none"
    assert response.splitter_config.flat_config is not None
    assert response.splitter_config.flat_config.chunk_size == 1024


def test_normalize_splitter_config_rejects_child_chunk_size_not_smaller_than_parent() -> (
    None
):
    with pytest.raises(ValueError, match="child_chunk_size"):
        normalize_splitter_config(
            {
                "chunk_strategy": "hierarchical",
                "hierarchical_config": {
                    "parent_chunk_size": 512,
                    "child_chunk_size": 512,
                    "child_chunk_overlap": 32,
                },
            }
        )
