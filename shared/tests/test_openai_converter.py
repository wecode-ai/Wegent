# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for OpenAI request conversion defaults."""

from shared.models.execution import ExecutionRequest
from shared.models.knowledge import KnowledgeBaseToolAccessMode
from shared.models.openai_converter import OpenAIRequestConverter


def test_from_execution_request_normalizes_null_kb_tool_access_mode():
    request = ExecutionRequest(kb_tool_access_mode=None)

    openai_request = OpenAIRequestConverter.from_execution_request(request)

    assert (
        openai_request["metadata"]["kb_tool_access_mode"]
        == KnowledgeBaseToolAccessMode.FULL
    )


def test_to_execution_request_normalizes_null_kb_tool_access_mode():
    openai_request = {
        "model": "test-model",
        "input": "hello",
        "metadata": {
            "kb_tool_access_mode": None,
        },
    }

    request = OpenAIRequestConverter.to_execution_request(openai_request)

    assert request.kb_tool_access_mode == KnowledgeBaseToolAccessMode.FULL
