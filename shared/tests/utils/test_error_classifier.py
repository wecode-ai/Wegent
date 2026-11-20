# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import pytest

from shared.utils.error_classifier import ChatErrorCode, classify_error


def test_classify_error_treats_chinese_timeout_as_timeout_error():
    assert classify_error("请求超时，请稍后重试") == "timeout_error"


def test_classify_error_keeps_connection_interrupt_as_network_error():
    assert (
        classify_error("peer closed connection without sending complete message body")
        == "network_error"
    )


@pytest.mark.parametrize(
    ("message", "expected"),
    [
        (
            "Agent Skills directory contains unmanaged entries",
            "skills_unmanaged_entries",
        ),
        (
            "Refusing to replace unmanaged agent Skills directory",
            "skill_deploy_failed",
        ),
        ("executor failed: insufficient_quota; rate limit", "quota_exceeded"),
        ("container request: permission denied", "permission_denied"),
        ("executor authentication expired", "authentication_expired"),
        ("upstream error: connection reset", "network_error"),
        ("connector not connected", "connector_unavailable"),
        ("executor request timed out", "timeout_error"),
        ("server overloaded", "server_overloaded"),
        ("502 Bad Gateway", "provider_error"),
        ("Error code: 429 - executor request failed", "rate_limit"),
        ("Error code: 429 - insufficient_quota", "quota_exceeded"),
        ("Reference 403913 is unavailable", "generic_error"),
        ("Error code: 4299", "generic_error"),
        ("Error code: 429abc", "generic_error"),
        ('Error code: 500 - {"code":"not_insufficient_quota"}', "provider_error"),
        ("max_tokens parameter is invalid", "generic_error"),
    ],
)
def test_specific_causes_precede_wrappers_without_guessing_from_ids(
    message: str, expected: str
) -> None:
    assert classify_error(message) == expected


def test_explicit_provider_quota_reason_precedes_rate_limit_exception() -> None:
    class RateLimitError(Exception):
        status_code = 429
        body = {"error": {"code": "insufficient_quota"}}

    assert classify_error(RateLimitError("too many requests")) == "quota_exceeded"


def test_quota_message_refines_a_rate_limit_subclass() -> None:
    class RateLimitError(Exception):
        pass

    class ProviderRateLimitError(RateLimitError):
        pass

    assert (
        classify_error(ProviderRateLimitError("insufficient_quota")) == "quota_exceeded"
    )


def test_authentication_expiration_refines_the_authentication_exception() -> None:
    class AuthenticationError(Exception):
        pass

    assert (
        classify_error(AuthenticationError("credentials expired"))
        == "authentication_expired"
    )


def test_structured_overload_code_precedes_network_message() -> None:
    error = RuntimeError("connection reset")
    error.code = "server_overloaded"  # type: ignore[attr-defined]
    assert classify_error(error) == "server_overloaded"


def test_bad_request_falls_through_to_http_status_when_message_is_unspecific() -> None:
    class BadRequestError(Exception):
        status_code = 413

    assert classify_error(BadRequestError("request rejected")) == "payload_too_large"


def test_bad_request_keeps_a_specific_message_cause_ahead_of_http_status() -> None:
    class BadRequestError(Exception):
        status_code = 413

    assert (
        classify_error(BadRequestError("maximum context length exceeded"))
        == "context_length_exceeded"
    )


def test_http_status_precedes_a_generic_runtime_wrapper() -> None:
    error = RuntimeError("executor request failed")
    error.status_code = 502  # type: ignore[attr-defined]
    assert classify_error(error) == "provider_error"


def test_quota_reason_precedes_http_status_metadata() -> None:
    error = RuntimeError("executor failed: insufficient_quota")
    error.status_code = 429  # type: ignore[attr-defined]
    assert classify_error(error) == "quota_exceeded"


@pytest.mark.parametrize(
    ("message", "expected"),
    [
        (
            "Agent Skills directory contains unmanaged entries",
            "skills_unmanaged_entries",
        ),
        ("request timeout", "timeout_error"),
        ("opaque failure", "model_unavailable"),
    ],
)
def test_legacy_llm_error_retains_the_specific_cause(
    message: str, expected: str
) -> None:
    error = RuntimeError(message)
    error.code = "llm_error"  # type: ignore[attr-defined]
    assert classify_error(error) == expected


def test_nested_business_code_precedes_the_legacy_llm_wrapper() -> None:
    error = RuntimeError("opaque failure")
    error.code = "llm_error"  # type: ignore[attr-defined]
    error.body = {"error": {"code": "insufficient_quota"}}  # type: ignore[attr-defined]
    assert classify_error(error) == "quota_exceeded"


def test_p0_business_codes_are_preserved_from_structured_errors() -> None:
    for code in ChatErrorCode:
        if code == ChatErrorCode.GENERIC_ERROR:
            continue
        error = RuntimeError("opaque failure")
        error.code = code.value  # type: ignore[attr-defined]
        assert classify_error(error) == code.value


@pytest.mark.parametrize(
    "code", ["EXECUTOR_DISPATCH_FAILED", "task_queue_failure", "task_queue_stalled"]
)
def test_dispatch_aliases_use_a_bounded_business_code(code: str) -> None:
    error = RuntimeError("opaque failure")
    error.code = code  # type: ignore[attr-defined]
    assert classify_error(error) == "dispatch_error"
