"""Tests for user-safe conversion error mapping."""

import pytest

from knowledge_doc_converter.services.error_mapper import (
    map_conversion_failure,
    map_multimodal_failure,
)


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


def test_maps_httpx_remote_disconnect_as_service_unavailable() -> None:
    failure = map_conversion_failure(
        "RemoteProtocolError:Server disconnected without sending a response.",
        provider="mineru",
    )

    assert failure.code == "conversion_service_unavailable"
    assert failure.retryable is True
    assert failure.provider == "mineru"


def test_maps_multimodal_auth_from_error_class_as_permanent() -> None:
    failure = map_multimodal_failure(
        "gemini_auth", retryable=False, model="gemini-3.5-flash"
    )

    assert failure.code == "model_permission_denied"
    assert failure.retryable is False
    assert failure.provider == "gemini"
    assert failure.model == "gemini-3.5-flash"


def test_maps_multimodal_empty_response_as_permanent() -> None:
    failure = map_multimodal_failure("gemini_empty_response", retryable=False)

    assert failure.code == "multimodal_empty_response"
    assert failure.retryable is False


def test_maps_exhausted_multimodal_server_error_as_retryable() -> None:
    failure = map_multimodal_failure("gemini_server", retryable=True)

    assert failure.code == "conversion_service_unavailable"
    assert failure.retryable is True


@pytest.mark.parametrize(
    "error_class",
    [
        "staging_proxy_network",
        "staging_proxy_server",
        "staging_session_invalid",
        "staging_resumable_session_lost",
        "staging_resumable_too_many_failures",
        "staging_resumable_stalled",
        "staging_resumable_incomplete",
        "video_download_url_unavailable",
        "video_download_url_unresolved",
    ],
)
def test_maps_internal_staging_and_fid_transient_errors_as_unavailable(
    error_class: str,
) -> None:
    failure = map_multimodal_failure(error_class, retryable=True)

    assert failure.code == "conversion_service_unavailable"
    assert failure.retryable is True


@pytest.mark.parametrize(
    ("error_class", "expected_code"),
    [
        ("staging_file_too_large", "multimodal_file_too_large"),
        ("staging_auth_error", "conversion_configuration_error"),
        ("staging_invalid_response", "conversion_configuration_error"),
    ],
)
def test_maps_internal_staging_permanent_errors(
    error_class: str,
    expected_code: str,
) -> None:
    failure = map_multimodal_failure(error_class, retryable=False)

    assert failure.code == expected_code
    assert failure.retryable is False
