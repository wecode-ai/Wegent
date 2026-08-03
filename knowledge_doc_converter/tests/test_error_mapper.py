"""Tests for user-safe conversion error mapping."""

from knowledge_doc_converter.services.error_mapper import map_conversion_failure


def test_maps_model_quota_error_without_exposing_raw_message() -> None:
    raw = (
        "403 PERMISSION_DENIED: 当前用户高价模型额度已用完 "
        "secret-detail, model_id: gemini-3.5-flash"
    )

    failure = map_conversion_failure(raw, provider="gemini")

    assert failure.code == "model_quota_exhausted"
    assert failure.retryable is False
    assert failure.provider == "gemini"
    assert failure.model == "gemini-3.5-flash"
    assert "secret-detail" not in failure.user_message


def test_maps_timeout_as_retryable() -> None:
    failure = map_conversion_failure("multimodal_soft_timeout")

    assert failure.code == "conversion_timeout"
    assert failure.retryable is True


def test_maps_empty_httpx_read_error_as_service_unavailable() -> None:
    failure = map_conversion_failure("ReadError:")

    assert failure.code == "conversion_service_unavailable"
    assert failure.retryable is True
