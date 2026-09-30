# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""The runtime index entry consumes the request the Backend index task sends."""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from knowledge_runtime.api.endpoints import index as index_endpoint
from shared.models import (
    PresignedUrlContentRef,
    RemoteAuthorizedRetrievalResources,
    RemoteIndexRequest,
    RemoteRetrievalResourceRef,
)


def _index_request() -> RemoteIndexRequest:
    """The payload shape the Backend index task posts to /internal/rag/index."""
    return RemoteIndexRequest(
        knowledge_base_id=7,
        user_id=42,
        document_id=100,
        source_file="release-notes.md",
        file_extension=".md",
        content_ref=PresignedUrlContentRef(
            kind="presigned_url",
            url="https://storage.example.com/release-notes.md",
        ),
        authorized_resources=RemoteAuthorizedRetrievalResources(
            knowledge_base_id=7,
            index_owner_user_id=42,
            retriever=RemoteRetrievalResourceRef(
                kind="Retriever", name="retriever-a", namespace="default"
            ),
            embedding_model=RemoteRetrievalResourceRef(
                kind="Model", name="embed-a", namespace="default"
            ),
        ),
    )


@pytest.mark.asyncio
async def test_index_endpoint_forwards_the_task_request_to_the_executor() -> None:
    """The runtime handler passes the whole task request to the index executor."""
    request = _index_request()
    executor = MagicMock()
    executor.execute = AsyncMock(
        return_value={"status": "success", "knowledge_id": "7", "doc_ref": "100"}
    )

    with patch.object(index_endpoint, "IndexExecutor", return_value=executor):
        result = await index_endpoint.index_document(request)

    executor.execute.assert_awaited_once_with(request)
    assert result == {
        "status": "success",
        "knowledge_id": "7",
        "doc_ref": "100",
    }


def test_index_request_keeps_the_authorized_references() -> None:
    """The wire request carries only references, not resolved configuration."""
    payload = _index_request().model_dump(mode="json", exclude_none=True)

    assert payload["authorized_resources"] == {
        "knowledge_base_id": 7,
        "index_owner_user_id": 42,
        "retriever": {
            "kind": "Retriever",
            "name": "retriever-a",
            "namespace": "default",
        },
        "embedding_model": {
            "kind": "Model",
            "name": "embed-a",
            "namespace": "default",
        },
        "explicit_selection": False,
    }
    assert "retriever_config" not in payload
    assert "embedding_model_config" not in payload
