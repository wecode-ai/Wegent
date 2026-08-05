# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0
"""Tests for Gemini error classification before callback mapping."""

from unittest.mock import patch

import pytest

from knowledge_doc_converter.services.error_mapper import map_multimodal_failure
from knowledge_doc_converter.services.errors import PermanentError, TransientError
from knowledge_doc_converter.services.gemini_analyzer import GeminiMultimodalAnalyzer
from knowledge_doc_converter.tasks.multimodal_task import (
    _safe_notify_failed,
    callback_client,
)


@pytest.mark.parametrize(
    ("raw_error", "expected_class", "expected_type"),
    [
        (
            "403 PERMISSION_DENIED: 当前用户高价模型额度已用完, "
            "model_id: gemini-3.5-flash",
            "gemini_quota",
            PermanentError,
        ),
        (
            "403 PERMISSION_DENIED: invalid API key",
            "gemini_auth",
            PermanentError,
        ),
        (
            "429 RESOURCE_EXHAUSTED: quota exhausted",
            "gemini_quota",
            PermanentError,
        ),
        (
            "503 UNAVAILABLE: temporarily overloaded",
            "gemini_server",
            TransientError,
        ),
        (
            "request timeout while calling model",
            "gemini_server",
            TransientError,
        ),
    ],
)
def test_classifies_gemini_error(
    raw_error: str,
    expected_class: str,
    expected_type: type[Exception],
) -> None:
    classified = GeminiMultimodalAnalyzer._classify_error(Exception(raw_error))

    assert isinstance(classified, expected_type)
    assert classified.error_class == expected_class


def test_internal_quota_error_maps_to_public_quota_code() -> None:
    raw_error = (
        "403 PERMISSION_DENIED: 当前用户高价模型额度已用完, "
        "model_id: gemini-3.5-flash"
    )
    classified = GeminiMultimodalAnalyzer._classify_error(Exception(raw_error))

    failure = map_multimodal_failure(
        classified.error_class,
        retryable=isinstance(classified, TransientError),
        provider="gemini",
        model="gemini-3.5-flash",
    )

    assert failure.code == "model_quota_exhausted"
    assert failure.retryable is False
    assert failure.provider == "gemini"
    assert failure.model == "gemini-3.5-flash"
    assert "额度已用完" not in failure.user_message


def test_internal_quota_error_is_forwarded_as_structured_callback() -> None:
    raw_error = (
        "403 PERMISSION_DENIED: 当前用户高价模型额度已用完, "
        "model_id: gemini-3.5-flash"
    )
    classified = GeminiMultimodalAnalyzer._classify_error(Exception(raw_error))

    with patch.object(callback_client, "notify_failed") as notify_failed:
        _safe_notify_failed(
            "/api/internal/conversion/callback/status",
            33252,
            7,
            str(classified),
            error_class=classified.error_class,
            retryable=isinstance(classified, TransientError),
            model="gemini-3.5-flash",
        )

    notify_failed.assert_called_once()
    payload = notify_failed.call_args.kwargs
    assert payload["error_code"] == "model_quota_exhausted"
    assert payload["retryable"] is False
    assert payload["provider"] == "gemini"
    assert payload["model"] == "gemini-3.5-flash"
