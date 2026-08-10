# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import json
import logging

import pytest

from chat_shell.services.chat_service import (
    _log_provider_native_e2e,
    _safe_tool_scope,
)


def test_safe_tool_scope_keeps_ids_and_drops_content() -> None:
    scope = _safe_tool_scope(
        {
            "data": {
                "input": {
                    "knowledge_base_id": 12,
                    "document_ids": [9, 10],
                    "include_subfolders": True,
                    "query": "sensitive query",
                    "content": "sensitive document content",
                }
            }
        }
    )

    assert scope == {
        "knowledge_base_id": 12,
        "document_ids": [9, 10],
        "include_subfolders": True,
    }


def test_provider_native_e2e_log_is_opt_in(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    caplog.set_level(logging.INFO, logger="chat_shell.services.chat_service")

    _log_provider_native_e2e("disabled", task_id=1)
    assert not caplog.records

    monkeypatch.setenv("PROVIDER_NATIVE_E2E_LOGGING", "true")
    _log_provider_native_e2e("enabled", task_id=1)

    payload = json.loads(caplog.records[-1].getMessage().split("] ", 1)[1])
    assert payload == {"event": "enabled", "task_id": 1}
