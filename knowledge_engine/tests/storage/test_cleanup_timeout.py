# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from unittest.mock import MagicMock, patch

import pytest

from knowledge_engine.storage.cleanup_timeout import CleanupTimeoutClient
from knowledge_engine.storage.factory import create_storage_backend_from_runtime_config
from shared.models import RuntimeRetrieverConfig


def test_milvus_cleanup_caps_rpc_timeouts_without_closing_shared_connections() -> None:
    sdk = MagicMock()
    sdk.query.return_value = [{"doc_ref": "11"}]
    client = CleanupTimeoutClient(sdk, 10.0)
    assert client.query(collection_name="shared", timeout=None) == [{"doc_ref": "11"}]
    sdk.query.assert_called_once_with(collection_name="shared", timeout=10.0)
    client.delete(collection_name="shared", filter='knowledge_id == "1"', timeout=30)
    sdk.delete.assert_called_once_with(
        collection_name="shared", filter='knowledge_id == "1"', timeout=10.0
    )
    sdk.close.assert_not_called()


@pytest.mark.parametrize(
    "provider,url,sdk_path",
    [
        ("qdrant", "http://qdrant:6333", "qdrant_backend.QdrantClient"),
        (
            "elasticsearch",
            "http://elasticsearch:9200",
            "elasticsearch_backend.Elasticsearch",
        ),
        ("milvus", "http://milvus:19530", "milvus_backend.MilvusClient"),
    ],
)
def test_cleanup_factory_propagates_a_finite_sdk_timeout(
    provider: str, url: str, sdk_path: str
) -> None:
    sdk = MagicMock()
    sdk.collection_exists.return_value = False
    sdk.indices.exists.return_value = False
    sdk.has_collection.return_value = False
    config = RuntimeRetrieverConfig(
        name="retriever",
        namespace="default",
        storage_config={
            "type": provider,
            "url": url,
        },
    )
    with patch(f"knowledge_engine.storage.{sdk_path}", return_value=sdk) as constructor:
        backend = create_storage_backend_from_runtime_config(
            config, request_timeout=10.0
        )
        result = backend.delete_document("1", "11")
    assert result["status"] == "deleted"
    if provider == "elasticsearch":
        assert constructor.call_args.kwargs["request_timeout"] == 10.0
    else:
        assert constructor.call_args.kwargs["timeout"] == 10.0
    if provider == "milvus":
        assert sdk.has_collection.call_args.kwargs["timeout"] == 10.0
