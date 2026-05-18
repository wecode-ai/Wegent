# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import pytest
from pydantic import ValidationError

import shared.models as shared_models


def _require_model(name: str):
    """Get a model from shared.models, failing the test if not exported."""
    model = getattr(shared_models, name, None)
    if model is None:
        pytest.fail(f"shared.models must export {name}")
    return model


# ============== Export verification ==============


def test_shared_models_exports_data_analysis_protocol_types() -> None:
    """All data analysis protocol types must be exported from shared.models."""
    exported_names = [
        "DuckDBColumnInfo",
        "DuckDBTableInfo",
        "RemoteDataGenerateRequest",
        "RemoteDataGenerateResponse",
        "RemoteDataQueryRequest",
        "RemoteDataQueryResponse",
        "RemoteDataSchemaRequest",
        "RemoteDataSchemaResponse",
    ]

    for name in exported_names:
        assert getattr(shared_models, name, None) is not None


# ============== RemoteDataGenerateRequest ==============


def test_generate_request_accepts_backend_attachment_stream_content_ref() -> None:
    """RemoteDataGenerateRequest should accept BackendAttachmentStreamContentRef."""
    RemoteDataGenerateRequest = _require_model("RemoteDataGenerateRequest")

    request = RemoteDataGenerateRequest.model_validate(
        {
            "attachment_id": 42,
            "content_ref": {
                "kind": "backend_attachment_stream",
                "url": "http://backend:8000/api/internal/rag/content/42",
                "auth_token": "test-token",
            },
        }
    )

    assert request.attachment_id == 42
    assert request.content_ref.kind == "backend_attachment_stream"
    assert request.content_ref.auth_token == "test-token"


def test_generate_request_accepts_presigned_url_content_ref() -> None:
    """RemoteDataGenerateRequest should accept PresignedUrlContentRef."""
    RemoteDataGenerateRequest = _require_model("RemoteDataGenerateRequest")

    request = RemoteDataGenerateRequest.model_validate(
        {
            "attachment_id": 42,
            "content_ref": {
                "kind": "presigned_url",
                "url": "https://storage.example.com/data.xlsx",
            },
        }
    )

    assert request.content_ref.kind == "presigned_url"


def test_generate_request_rejects_unknown_content_ref_kind() -> None:
    """RemoteDataGenerateRequest should reject unknown content_ref kinds."""
    RemoteDataGenerateRequest = _require_model("RemoteDataGenerateRequest")

    with pytest.raises(ValidationError):
        RemoteDataGenerateRequest.model_validate(
            {
                "attachment_id": 42,
                "content_ref": {
                    "kind": "unsupported_kind",
                    "url": "http://example.com/file",
                },
            }
        )


def test_generate_request_rejects_missing_attachment_id() -> None:
    """RemoteDataGenerateRequest should require attachment_id."""
    RemoteDataGenerateRequest = _require_model("RemoteDataGenerateRequest")

    with pytest.raises(ValidationError):
        RemoteDataGenerateRequest.model_validate(
            {
                "content_ref": {
                    "kind": "backend_attachment_stream",
                    "url": "http://backend:8000/api/internal/rag/content/42",
                    "auth_token": "test-token",
                },
            }
        )


def test_generate_request_rejects_missing_content_ref() -> None:
    """RemoteDataGenerateRequest should require content_ref."""
    RemoteDataGenerateRequest = _require_model("RemoteDataGenerateRequest")

    with pytest.raises(ValidationError):
        RemoteDataGenerateRequest.model_validate(
            {
                "attachment_id": 42,
            }
        )


def test_generate_request_optional_fields_default_to_none() -> None:
    """RemoteDataGenerateRequest optional fields should default to None."""
    RemoteDataGenerateRequest = _require_model("RemoteDataGenerateRequest")

    request = RemoteDataGenerateRequest.model_validate(
        {
            "attachment_id": 42,
            "content_ref": {
                "kind": "backend_attachment_stream",
                "url": "http://backend:8000/api/internal/rag/content/42",
                "auth_token": "test-token",
            },
        }
    )

    assert request.source_file is None
    assert request.file_extension is None
    assert request.extensions is None


def test_generate_request_rejects_extra_fields() -> None:
    """RemoteDataGenerateRequest should reject unknown fields (extra='forbid')."""
    RemoteDataGenerateRequest = _require_model("RemoteDataGenerateRequest")

    with pytest.raises(ValidationError):
        RemoteDataGenerateRequest.model_validate(
            {
                "attachment_id": 42,
                "content_ref": {
                    "kind": "backend_attachment_stream",
                    "url": "http://backend:8000/api/internal/rag/content/42",
                    "auth_token": "test-token",
                },
                "unknown_field": "value",
            }
        )


# ============== RemoteDataQueryRequest ==============


def test_query_request_accepts_valid_max_rows() -> None:
    """RemoteDataQueryRequest should accept valid max_rows values."""
    RemoteDataQueryRequest = _require_model("RemoteDataQueryRequest")

    request = RemoteDataQueryRequest.model_validate(
        {
            "attachment_id": 42,
            "content_ref": {
                "kind": "backend_attachment_stream",
                "url": "http://backend:8000/api/internal/rag/content/42",
                "auth_token": "test-token",
            },
            "sql": "SELECT * FROM data_db.sales LIMIT 10",
            "max_rows": 500,
        }
    )

    assert request.max_rows == 500


def test_query_request_default_max_rows() -> None:
    """RemoteDataQueryRequest should default max_rows to 5000."""
    RemoteDataQueryRequest = _require_model("RemoteDataQueryRequest")

    request = RemoteDataQueryRequest.model_validate(
        {
            "attachment_id": 42,
            "content_ref": {
                "kind": "backend_attachment_stream",
                "url": "http://backend:8000/api/internal/rag/content/42",
                "auth_token": "test-token",
            },
            "sql": "SELECT * FROM data_db.sales",
        }
    )

    assert request.max_rows == 5000


def test_query_request_rejects_max_rows_zero() -> None:
    """RemoteDataQueryRequest should reject max_rows=0."""
    RemoteDataQueryRequest = _require_model("RemoteDataQueryRequest")

    with pytest.raises(ValidationError):
        RemoteDataQueryRequest.model_validate(
            {
                "attachment_id": 42,
                "content_ref": {
                    "kind": "backend_attachment_stream",
                    "url": "http://backend:8000/api/internal/rag/content/42",
                    "auth_token": "test-token",
                },
                "sql": "SELECT 1",
                "max_rows": 0,
            }
        )


def test_query_request_rejects_max_rows_exceeding_limit() -> None:
    """RemoteDataQueryRequest should reject max_rows > 10000."""
    RemoteDataQueryRequest = _require_model("RemoteDataQueryRequest")

    with pytest.raises(ValidationError):
        RemoteDataQueryRequest.model_validate(
            {
                "attachment_id": 42,
                "content_ref": {
                    "kind": "backend_attachment_stream",
                    "url": "http://backend:8000/api/internal/rag/content/42",
                    "auth_token": "test-token",
                },
                "sql": "SELECT 1",
                "max_rows": 10001,
            }
        )


def test_query_request_accepts_max_rows_at_boundary() -> None:
    """RemoteDataQueryRequest should accept max_rows=10000 at the boundary."""
    RemoteDataQueryRequest = _require_model("RemoteDataQueryRequest")

    request = RemoteDataQueryRequest.model_validate(
        {
            "attachment_id": 42,
            "content_ref": {
                "kind": "backend_attachment_stream",
                "url": "http://backend:8000/api/internal/rag/content/42",
                "auth_token": "test-token",
            },
            "sql": "SELECT 1",
            "max_rows": 10000,
        }
    )

    assert request.max_rows == 10000


def test_query_request_rejects_missing_sql() -> None:
    """RemoteDataQueryRequest should require sql field."""
    RemoteDataQueryRequest = _require_model("RemoteDataQueryRequest")

    with pytest.raises(ValidationError):
        RemoteDataQueryRequest.model_validate(
            {
                "attachment_id": 42,
                "content_ref": {
                    "kind": "backend_attachment_stream",
                    "url": "http://backend:8000/api/internal/rag/content/42",
                    "auth_token": "test-token",
                },
            }
        )


def test_query_request_rejects_extra_fields() -> None:
    """RemoteDataQueryRequest should reject unknown fields (extra='forbid')."""
    RemoteDataQueryRequest = _require_model("RemoteDataQueryRequest")

    with pytest.raises(ValidationError):
        RemoteDataQueryRequest.model_validate(
            {
                "attachment_id": 42,
                "content_ref": {
                    "kind": "backend_attachment_stream",
                    "url": "http://backend:8000/api/internal/rag/content/42",
                    "auth_token": "test-token",
                },
                "sql": "SELECT 1",
                "unexpected_field": True,
            }
        )


# ============== RemoteDataSchemaRequest ==============


def test_schema_request_basic_construction() -> None:
    """RemoteDataSchemaRequest should accept required fields."""
    RemoteDataSchemaRequest = _require_model("RemoteDataSchemaRequest")

    request = RemoteDataSchemaRequest.model_validate(
        {
            "attachment_id": 42,
            "content_ref": {
                "kind": "backend_attachment_stream",
                "url": "http://backend:8000/api/internal/rag/content/42",
                "auth_token": "test-token",
            },
        }
    )

    assert request.attachment_id == 42
    assert request.extensions is None


def test_schema_request_rejects_missing_attachment_id() -> None:
    """RemoteDataSchemaRequest should require attachment_id."""
    RemoteDataSchemaRequest = _require_model("RemoteDataSchemaRequest")

    with pytest.raises(ValidationError):
        RemoteDataSchemaRequest.model_validate(
            {
                "content_ref": {
                    "kind": "backend_attachment_stream",
                    "url": "http://backend:8000/api/internal/rag/content/42",
                    "auth_token": "test-token",
                },
            }
        )


def test_schema_request_rejects_extra_fields() -> None:
    """RemoteDataSchemaRequest should reject unknown fields (extra='forbid')."""
    RemoteDataSchemaRequest = _require_model("RemoteDataSchemaRequest")

    with pytest.raises(ValidationError):
        RemoteDataSchemaRequest.model_validate(
            {
                "attachment_id": 42,
                "content_ref": {
                    "kind": "backend_attachment_stream",
                    "url": "http://backend:8000/api/internal/rag/content/42",
                    "auth_token": "test-token",
                },
                "rogue_field": True,
            }
        )


# ============== Response models ==============


def test_generate_response_with_success() -> None:
    """RemoteDataGenerateResponse should accept success result."""
    RemoteDataGenerateResponse = _require_model("RemoteDataGenerateResponse")

    response = RemoteDataGenerateResponse.model_validate(
        {
            "success": True,
            "attachment_id": 42,
            "duckdb_attachment_id": 99,
            "tables": [
                {
                    "name": "sales",
                    "row_count": 1000,
                    "columns": [
                        {"name": "id", "type": "INTEGER", "null_count": 0},
                        {"name": "amount", "type": "DOUBLE", "null_count": 5},
                    ],
                }
            ],
            "generation_time_ms": 150.5,
        }
    )

    assert response.success is True
    assert response.duckdb_attachment_id == 99
    assert len(response.tables) == 1
    assert response.tables[0].name == "sales"
    assert len(response.tables[0].columns) == 2


def test_generate_response_with_error() -> None:
    """RemoteDataGenerateResponse should accept error result."""
    RemoteDataGenerateResponse = _require_model("RemoteDataGenerateResponse")

    response = RemoteDataGenerateResponse.model_validate(
        {
            "success": False,
            "attachment_id": 42,
            "error": "DuckDB generation failed: file too large",
        }
    )

    assert response.success is False
    assert response.duckdb_attachment_id is None
    assert "file too large" in response.error


def test_query_response_with_results() -> None:
    """RemoteDataQueryResponse should accept query results."""
    RemoteDataQueryResponse = _require_model("RemoteDataQueryResponse")

    response = RemoteDataQueryResponse.model_validate(
        {
            "success": True,
            "columns": ["id", "name"],
            "rows": [[1, "Alice"], [2, "Bob"]],
            "row_count": 2,
            "truncated": False,
        }
    )

    assert response.success is True
    assert response.columns == ["id", "name"]
    assert response.row_count == 2
    assert response.truncated is False


def test_query_response_with_truncation() -> None:
    """RemoteDataQueryResponse should report truncation with total_count."""
    RemoteDataQueryResponse = _require_model("RemoteDataQueryResponse")

    response = RemoteDataQueryResponse.model_validate(
        {
            "success": True,
            "columns": ["id"],
            "rows": [[i] for i in range(5000)],
            "row_count": 5000,
            "total_count": 8000,
            "truncated": True,
        }
    )

    assert response.truncated is True
    assert response.total_count == 8000


def test_schema_response_with_tables() -> None:
    """RemoteDataSchemaResponse should accept schema with tables."""
    RemoteDataSchemaResponse = _require_model("RemoteDataSchemaResponse")

    response = RemoteDataSchemaResponse.model_validate(
        {
            "attachment_id": 42,
            "tables": [
                {
                    "name": "orders",
                    "row_count": 500,
                    "columns": [
                        {"name": "order_id", "type": "BIGINT", "null_count": 0},
                    ],
                },
            ],
        }
    )

    assert response.attachment_id == 42
    assert len(response.tables) == 1
    assert response.tables[0].name == "orders"
    assert response.error is None


def test_schema_response_with_error() -> None:
    """RemoteDataSchemaResponse should accept error result."""
    RemoteDataSchemaResponse = _require_model("RemoteDataSchemaResponse")

    response = RemoteDataSchemaResponse.model_validate(
        {
            "attachment_id": 42,
            "error": "Schema extraction failed",
        }
    )

    assert response.error == "Schema extraction failed"
    assert response.tables == []


# ============== All models extra='forbid' ==============


@pytest.mark.parametrize(
    ("model_name", "payload"),
    [
        (
            "DuckDBColumnInfo",
            {"name": "col", "type": "INT", "null_count": 0, "extra": True},
        ),
        (
            "DuckDBTableInfo",
            {"name": "t", "row_count": 1, "columns": [], "extra": True},
        ),
        (
            "RemoteDataGenerateResponse",
            {"success": True, "attachment_id": 1, "extra": True},
        ),
        (
            "RemoteDataQueryResponse",
            {"success": True, "columns": [], "rows": [], "row_count": 0, "extra": True},
        ),
        (
            "RemoteDataSchemaResponse",
            {"attachment_id": 1, "tables": [], "extra": True},
        ),
    ],
)
def test_all_protocol_models_reject_extra_fields(
    model_name: str,
    payload: dict,
) -> None:
    """All protocol models should reject extra fields (extra='forbid')."""
    model = _require_model(model_name)

    with pytest.raises(ValidationError):
        model.model_validate(payload)
