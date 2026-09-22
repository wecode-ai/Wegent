# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import base64
import struct
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from pytest_mock import MockerFixture

from knowledge_engine.embedding.contract import ensure_vector_contract
from knowledge_engine.embedding.custom import CustomEmbedding
from knowledge_engine.embedding.errors import (
    EmbeddingDimensionMismatchError,
    EmbeddingResponseFormatError,
)
from knowledge_engine.embedding.factory import (
    create_embedding_model_from_runtime_config,
)
from shared.models import RuntimeEmbeddingModelConfig


def test_create_embedding_model_uses_runtime_model_name_when_model_id_missing(
    mocker: MockerFixture,
) -> None:
    custom_embedding_cls = mocker.patch(
        "knowledge_engine.embedding.factory.CustomEmbedding",
        return_value=SimpleNamespace(),
    )

    create_embedding_model_from_runtime_config(
        RuntimeEmbeddingModelConfig(
            model_name="custom-embedding-model",
            resolved_config={
                "protocol": "openai",
                "base_url": "https://api.openai.com/v1",
                "custom_headers": {"X-Test": "1"},
                "encoding_format": "float",
            },
        )
    )

    custom_embedding_cls.assert_called_once_with(
        api_url="https://api.openai.com/v1/embeddings",
        model="custom-embedding-model",
        headers={"X-Test": "1"},
        api_key=None,
        dimensions=None,
        encoding_format="float",
    )


def test_create_embedding_model_exposes_additional_input_modalities(
    mocker: MockerFixture,
) -> None:
    embedding_instance = SimpleNamespace()
    custom_embedding_cls = mocker.patch(
        "knowledge_engine.embedding.factory.CustomEmbedding",
        return_value=embedding_instance,
    )

    result = create_embedding_model_from_runtime_config(
        RuntimeEmbeddingModelConfig(
            model_name="custom-embedding-model",
            resolved_config={
                "protocol": "custom",
                "base_url": "https://example.com/embeddings",
                "additional_input_modalities": ["image"],
            },
        )
    )

    custom_embedding_cls.assert_called_once()
    assert result is embedding_instance
    assert result._additional_input_modalities == ["image"]


@pytest.mark.asyncio
async def test_custom_embedding_supports_async_text_embedding(
    mocker: MockerFixture,
) -> None:
    embedding = CustomEmbedding(
        api_url="https://api.openai.com/v1/embeddings",
        model="text-embedding-3-small",
    )
    mocker.patch.object(embedding, "_call_api", return_value=[0.1, 0.2, 0.3])

    result = await embedding._aget_text_embedding("release plan")

    assert result == [0.1, 0.2, 0.3]


def test_custom_embedding_sends_configured_output_format(
    mocker: MockerFixture,
) -> None:
    post = mocker.patch("knowledge_engine.embedding.custom.requests.post")
    post.return_value.json.return_value = {"data": [{"embedding": [0.1, 0.2, 0.3]}]}
    embedding = CustomEmbedding(
        api_url="https://api.example.com/v1/embeddings",
        model="custom-embedding-model",
        dimensions=3,
        encoding_format="float",
    )

    result = embedding.get_text_embedding("release plan")

    assert result == [0.1, 0.2, 0.3]
    assert post.call_args.kwargs["json"] == {
        "model": "custom-embedding-model",
        "input": "release plan",
        "dimensions": 3,
        "encoding_format": "float",
    }


def test_custom_embedding_omits_unconfigured_output_format(
    mocker: MockerFixture,
) -> None:
    post = mocker.patch("knowledge_engine.embedding.custom.requests.post")
    post.return_value.json.return_value = {"data": [{"embedding": [0.1]}]}
    embedding = CustomEmbedding(
        api_url="https://api.example.com/v1/embeddings",
        model="custom-embedding-model",
    )

    embedding.get_text_embedding("release plan")
    embedding.get_text_embedding("incident review")

    assert [call.kwargs["json"] for call in post.call_args_list] == [
        {
            "model": "custom-embedding-model",
            "input": "release plan",
        },
        {
            "model": "custom-embedding-model",
            "input": "incident review",
        },
    ]


def test_custom_embedding_decodes_base64_float_response(
    mocker: MockerFixture,
) -> None:
    encoded = base64.b64encode(struct.pack("<3f", 0.1, 0.2, 0.3)).decode()
    post = mocker.patch("knowledge_engine.embedding.custom.requests.post")
    post.return_value.json.return_value = {"data": [{"embedding": encoded}]}
    embedding = CustomEmbedding(
        api_url="https://api.example.com/v1/embeddings",
        model="custom-embedding-model",
        dimensions=3,
        encoding_format="base64",
    )

    result = embedding.get_text_embedding("release plan")

    assert result == pytest.approx([0.1, 0.2, 0.3])


@pytest.mark.parametrize(
    ("response_embedding", "encoding_format", "expected_message"),
    [
        pytest.param(
            [0.1, 0.2, 0.3],
            "base64",
            "base64 string",
            id="base64-non-string",
        ),
        pytest.param(
            "not-valid-base64!",
            "base64",
            "Invalid base64",
            id="invalid-base64",
        ),
        pytest.param(
            "非 ASCII 响应",
            "base64",
            "Invalid base64",
            id="non-ascii-base64",
        ),
        pytest.param(
            "not-a-numeric-vector",
            "float",
            "numeric embedding array",
            id="float-string",
        ),
        pytest.param(
            "not-a-numeric-vector",
            None,
            "numeric embedding array",
            id="default-string",
        ),
        pytest.param(
            ["not-a-number"],
            None,
            "numeric embedding array",
            id="non-numeric-array",
        ),
    ],
)
def test_custom_embedding_rejects_invalid_provider_response_without_retry(
    mocker: MockerFixture,
    response_embedding: object,
    encoding_format: str | None,
    expected_message: str,
) -> None:
    post = mocker.patch("knowledge_engine.embedding.custom.requests.post")
    post.return_value.json.return_value = {"data": [{"embedding": response_embedding}]}
    embedding = CustomEmbedding(
        api_url="https://api.example.com/v1/embeddings",
        model="custom-embedding-model",
        encoding_format=encoding_format,
    )

    with pytest.raises(EmbeddingResponseFormatError, match=expected_message):
        embedding.get_text_embedding("release plan")

    assert post.call_count == 1


@pytest.mark.parametrize(
    "response_payload",
    [
        pytest.param(ValueError("invalid JSON"), id="invalid-json"),
        pytest.param({}, id="missing-data"),
        pytest.param({"data": []}, id="empty-data"),
        pytest.param({"data": "invalid"}, id="invalid-data-type"),
        pytest.param({"data": [{}]}, id="missing-embedding"),
    ],
)
def test_custom_embedding_rejects_invalid_response_envelope_without_retry(
    mocker: MockerFixture,
    response_payload: object,
) -> None:
    post = mocker.patch("knowledge_engine.embedding.custom.requests.post")
    if isinstance(response_payload, Exception):
        post.return_value.json.side_effect = response_payload
    else:
        post.return_value.json.return_value = response_payload
    embedding = CustomEmbedding(
        api_url="https://api.example.com/v1/embeddings",
        model="custom-embedding-model",
    )

    with pytest.raises(EmbeddingResponseFormatError, match="response envelope"):
        embedding.get_text_embedding("release plan")

    assert post.call_count == 1


def test_custom_embedding_rejects_unexpected_response_dimensions(
    mocker: MockerFixture,
) -> None:
    post = mocker.patch("knowledge_engine.embedding.custom.requests.post")
    post.return_value.json.return_value = {
        "data": [{"embedding": [0.1, 0.2, 0.3, 0.4]}]
    }
    embedding = CustomEmbedding(
        api_url="https://api.example.com/v1/embeddings",
        model="custom-embedding-model",
        dimensions=3,
    )

    with pytest.raises(EmbeddingDimensionMismatchError) as exc_info:
        embedding.get_text_embedding("release plan")

    assert exc_info.value.model == "custom-embedding-model"
    assert exc_info.value.expected == 3
    assert exc_info.value.actual == 4
    assert post.call_count == 1


def test_custom_embedding_rejects_unexpected_query_dimensions(
    mocker: MockerFixture,
) -> None:
    post = mocker.patch("knowledge_engine.embedding.custom.requests.post")
    post.return_value.json.return_value = {
        "data": [{"embedding": [0.1, 0.2, 0.3, 0.4]}]
    }
    embedding = CustomEmbedding(
        api_url="https://api.example.com/v1/embeddings",
        model="custom-embedding-model",
        dimensions=3,
    )

    with pytest.raises(EmbeddingDimensionMismatchError) as exc_info:
        embedding.get_query_embedding("release plan")

    assert exc_info.value.expected == 3
    assert exc_info.value.actual == 4


def test_openai_embedding_rejects_undeclared_document_dimensions(
    mocker: MockerFixture,
) -> None:
    mocker.patch(
        "llama_index.embeddings.openai.base.get_embeddings",
        return_value=[[0.1, 0.2, 0.3, 0.4]],
    )
    embedding = create_embedding_model_from_runtime_config(
        RuntimeEmbeddingModelConfig(
            model_name="text-embedding-3-small",
            resolved_config={
                "protocol": "openai",
                "api_key": "sk-test",
                "dimensions": 3,
            },
        )
    )

    with pytest.raises(EmbeddingDimensionMismatchError) as exc_info:
        embedding.get_text_embedding_batch(["release plan"])

    assert exc_info.value.model == "text-embedding-3-small"
    assert exc_info.value.expected == 3
    assert exc_info.value.actual == 4


def test_openai_embedding_rejects_undeclared_query_dimensions(
    mocker: MockerFixture,
) -> None:
    mocker.patch(
        "llama_index.embeddings.openai.base.get_embedding",
        return_value=[0.1, 0.2, 0.3, 0.4],
    )
    embedding = create_embedding_model_from_runtime_config(
        RuntimeEmbeddingModelConfig(
            model_name="text-embedding-3-small",
            resolved_config={
                "protocol": "openai",
                "api_key": "sk-test",
                "dimensions": 3,
            },
        )
    )

    with pytest.raises(EmbeddingDimensionMismatchError) as exc_info:
        embedding.get_query_embedding("release plan")

    assert exc_info.value.expected == 3
    assert exc_info.value.actual == 4


@pytest.mark.parametrize("value", [float("nan"), float("inf"), float("-inf")])
def test_vector_contract_rejects_non_finite_values_without_a_declaration(
    value: float,
) -> None:
    with pytest.raises(EmbeddingResponseFormatError, match="non-finite"):
        ensure_vector_contract(
            model="any-model",
            declared=None,
            vectors=[[0.1, value]],
        )


@pytest.mark.parametrize(
    "vector",
    [
        "0.1,0.2,0.3",
        [0.1, True, 0.3],
        [0.1, "0.2", 0.3],
    ],
)
def test_vector_contract_rejects_values_that_are_not_real_vectors(
    vector: object,
) -> None:
    with pytest.raises(EmbeddingResponseFormatError):
        ensure_vector_contract(
            model="any-model",
            declared=3,
            vectors=[vector],
        )


def test_vector_contract_accepts_an_all_zero_vector() -> None:
    ensure_vector_contract(
        model="any-model",
        declared=3,
        vectors=[[0.0, 0.0, 0.0]],
    )


def test_vector_contract_accepts_a_declared_legacy_vector() -> None:
    ensure_vector_contract(
        model="any-model",
        declared=3,
        vectors=[[0.1, 0.2, 0.3]],
    )
