# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Embedding retries remain observable without leaking provider errors."""

import logging

import httpx
import openai
import pytest
import requests

from knowledge_engine.embedding.custom import CustomEmbedding
from knowledge_engine.embedding.openai_embedding import DimensionCheckedOpenAIEmbedding


def test_custom_retry_keeps_policy_and_logs_attempts(mocker, caplog):
    caplog.set_level(logging.INFO, logger="knowledge_engine.diagnostics")
    mocker.patch("tenacity.nap.time.sleep")
    response = mocker.MagicMock()
    response.json.return_value = {"data": [{"embedding": [0.1]}]}
    post = mocker.patch(
        "knowledge_engine.embedding.custom.requests.post",
        side_effect=[requests.Timeout("private-token"), response],
    )
    embedding = CustomEmbedding(
        api_url="https://provider/embeddings?key=private-key",
        model="test-model",
        api_key="private-key",
    )

    assert embedding.get_query_embedding("private query") == [0.1]

    assert post.call_count == 2
    attempts = [m for m in caplog.messages if "stage=embedding_attempt " in m]
    assert len(attempts) == 1 and "attempt=2" in attempts[0]
    assert "stage=embedding_retry event=scheduled" in caplog.text
    assert "sleep_ms=2000.0 error_type=Timeout" in caplog.text
    assert any(r.levelno == logging.WARNING for r in caplog.records)
    for secret in ("private-token", "private-key", "private query"):
        assert secret not in caplog.text


@pytest.mark.parametrize("asynchronous", [False, True])
@pytest.mark.asyncio
async def test_openai_query_retry_preserves_result_and_logs_safely(
    asynchronous, mocker, caplog
):
    caplog.set_level(logging.INFO, logger="knowledge_engine.diagnostics")
    mocker.patch("tenacity.nap.time.sleep")
    mocker.patch("asyncio.sleep", new_callable=mocker.AsyncMock)
    failure = openai.APIConnectionError(
        message="private-provider-error",
        request=httpx.Request("POST", "https://provider/embeddings?key=private-key"),
    )
    function_name = "aget_embedding" if asynchronous else "get_embedding"
    call = mocker.patch(
        f"llama_index.embeddings.openai.base.{function_name}",
        side_effect=[failure, [0.1]],
    )
    embedding = DimensionCheckedOpenAIEmbedding(
        api_key="private-key",
        model="text-embedding-3-small",
    )
    # Keep the inherited retry stop/wait policy; replace only the test's sleep.
    if asynchronous:
        result = await embedding._aget_query_embedding("private query")
    else:
        result = embedding._get_query_embedding("private query")

    assert result == [0.1]
    assert call.call_count == 2
    attempts = [m for m in caplog.messages if "stage=embedding_attempt " in m]
    assert len(attempts) == 1 and "attempt=2" in attempts[0]
    assert "error_type=APIConnectionError" in caplog.text
    assert "stage=embedding_call event=end" in caplog.text
    for secret in ("private-provider-error", "private-key", "private query"):
        assert secret not in caplog.text


@pytest.mark.parametrize("adapter", ["custom", "openai"])
def test_retry_exhaustion_preserves_attempt_limit_and_exception(
    adapter, mocker, caplog
):
    caplog.set_level(logging.INFO, logger="knowledge_engine.diagnostics")
    mocker.patch("tenacity.nap.time.sleep")
    if adapter == "custom":
        failure = requests.Timeout("private-provider-error")
        call = mocker.patch(
            "knowledge_engine.embedding.custom.requests.post", side_effect=failure
        )
        embedding = CustomEmbedding(api_url="https://provider", model="test-model")
        expected_attempts = 3
    else:
        failure = openai.APIConnectionError(
            message="private-provider-error",
            request=httpx.Request("POST", "https://provider"),
        )
        call = mocker.patch(
            "llama_index.embeddings.openai.base.get_embedding", side_effect=failure
        )
        embedding = DimensionCheckedOpenAIEmbedding(
            api_key="private-key", model="text-embedding-3-small", max_retries=2
        )
        expected_attempts = 2

    with pytest.raises(type(failure)) as caught:
        embedding.get_query_embedding("private query")

    assert caught.value is failure
    assert call.call_count == expected_attempts
    attempts = [m for m in caplog.messages if "stage=embedding_attempt " in m]
    retries = [m for m in caplog.messages if "stage=embedding_retry " in m]
    assert len(attempts) == expected_attempts - 1
    assert len(retries) == expected_attempts - 1
    assert "private-provider-error" not in caplog.text


def test_successful_first_attempt_only_logs_request_duration(mocker, caplog) -> None:
    caplog.set_level(logging.INFO, logger="knowledge_engine.diagnostics")
    response = mocker.MagicMock()
    response.json.return_value = {"data": [{"embedding": [0.1]}]}
    post = mocker.patch(
        "knowledge_engine.embedding.custom.requests.post", return_value=response
    )
    embedding = CustomEmbedding(api_url="https://provider", model="test-model")

    assert embedding.get_query_embedding("private query") == [0.1]

    post.assert_called_once()
    assert len(caplog.records) == 1
    assert caplog.records[0].levelno == logging.INFO
    assert "stage=embedding_request event=end" in caplog.messages[0]
    assert "duration_ms=" in caplog.messages[0]
    assert "private query" not in caplog.text
