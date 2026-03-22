# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for safe LLM logging helpers."""

import json

from chat_shell.llm_logging import REDACTED_PLACEHOLDER, redact_sensitive_fields


def test_redact_sensitive_fields_redacts_embedded_tool_payload():
    payload = {
        "data": {
            "input": {
                "messages": [
                    {
                        "content": json.dumps(
                            {
                                "query": "diagnose",
                                "results": [{"content": "secret chunk"}],
                                "restricted_safe_summary": {
                                    "summary": "safe diagnosis"
                                },
                            },
                            ensure_ascii=False,
                        )
                    }
                ]
            }
        }
    }

    sanitized = redact_sensitive_fields(payload)
    content = sanitized["data"]["input"]["messages"][0]["content"]

    assert "secret chunk" not in content
    assert "safe diagnosis" in content
    assert REDACTED_PLACEHOLDER in content


def test_redact_sensitive_fields_redacts_protected_content_and_attachments():
    payload = {
        "attachment": "binary-data",
        "content": (
            "[Protected KB source material for internal reasoning only]\n"
            "Sensitive content"
        ),
        "output": "safe answer",
    }

    sanitized = redact_sensitive_fields(payload)

    assert sanitized["attachment"] == REDACTED_PLACEHOLDER
    assert sanitized["content"] == REDACTED_PLACEHOLDER
    assert sanitized["output"] == "safe answer"
