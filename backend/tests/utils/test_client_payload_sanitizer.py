# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from app.utils.client_payload_sanitizer import sanitize_client_payload


def test_removes_private_workflow_urls_but_preserves_tool_output() -> None:
    payload = {
        "query_url": "http://internal/query",
        "blocks": [
            {
                "type": "tool",
                "tool_output": {
                    "success": True,
                    "task_url": "http://internal/task",
                },
            },
            {
                "type": "card",
                "card_preview_data": {
                    "title": "pending",
                    "polling_url": "http://internal/poll",
                },
            },
        ],
    }

    sanitized = sanitize_client_payload(payload)

    assert "query_url" not in sanitized
    assert sanitized["blocks"][0]["tool_output"] == {"success": True}
    assert sanitized["blocks"][1]["card_preview_data"] == {"title": "pending"}
