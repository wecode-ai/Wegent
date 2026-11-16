# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from typing import Any
from unittest.mock import MagicMock, patch

import pytest
from elastic_transport import ConnectionTimeout
from qdrant_client.http.exceptions import UnexpectedResponse

from knowledge_engine.storage.elasticsearch_backend import ElasticsearchBackend
from knowledge_engine.storage.qdrant_backend import QdrantBackend
from shared.knowledge_cleanup import ExternalEngineCleanupError


def test_missing_main_collection_does_not_hide_a_parent_cleanup_failure() -> None:
    client = MagicMock()
    client.collection_exists.side_effect = lambda name: name.endswith("__parents")
    client.delete.side_effect = UnexpectedResponse(403, "credentials expired", b"", {})
    with patch(
        "knowledge_engine.storage.qdrant_backend.QdrantClient", return_value=client
    ):
        backend = QdrantBackend(
            {
                "url": "http://qdrant:6333",
                "indexStrategy": {"mode": "per_dataset"},
            }
        )
        with pytest.raises(UnexpectedResponse):
            backend.delete_document("1", "11")
    selection = client.delete.call_args.kwargs["points_selector"]
    assert {item.key: item.match.value for item in selection.filter.must} == {
        "knowledge_id": "1",
        "doc_ref": "11",
    }


def test_missing_es_main_index_does_not_hide_parent_cleanup_failure() -> None:
    client = MagicMock()
    client.indices.exists.side_effect = lambda *, index: index.endswith("__parents")
    client.delete_by_query.side_effect = ConnectionTimeout("external timeout")
    with patch(
        "knowledge_engine.storage.elasticsearch_backend.Elasticsearch",
        return_value=client,
    ):
        backend = ElasticsearchBackend(
            {
                "url": "http://elasticsearch:9200",
                "indexStrategy": {"mode": "per_dataset"},
            }
        )
        with pytest.raises(ConnectionTimeout):
            backend.delete_document("1", "11")


@pytest.mark.parametrize(
    "operation", ["delete_parent_nodes", "delete_document", "delete_knowledge"]
)
@pytest.mark.parametrize(
    "result",
    [
        {"deleted": 1, "timed_out": True},
        {"deleted": 1, "failures": [{"cause": "unknown"}]},
        {"deleted": 1, "version_conflicts": 1},
    ],
)
def test_es_partial_parent_cleanup_is_not_reported_as_confirmed(
    result: dict[str, Any], operation: str
) -> None:
    client = MagicMock()
    client.indices.exists.return_value = True
    client.delete_by_query.return_value = result
    with patch(
        "knowledge_engine.storage.elasticsearch_backend.Elasticsearch",
        return_value=client,
    ):
        backend = ElasticsearchBackend({"url": "http://elasticsearch:9200"})
        with pytest.raises(RuntimeError) as caught:
            if operation == "delete_knowledge":
                backend.delete_knowledge("1")
            else:
                getattr(backend, operation)("1", "11")
    assert isinstance(caught.value, ExternalEngineCleanupError) is (
        result.get("timed_out") is True
    )


@pytest.mark.parametrize(
    "failure", [{"failures": [{"cause": "unknown"}]}, {"version_conflicts": 1}]
)
def test_es_mixed_unknown_failure_is_not_overridden_by_timeout(
    failure: dict[str, Any],
) -> None:
    client = MagicMock()
    client.indices.exists.return_value = True
    client.delete_by_query.return_value = {"deleted": 1, "timed_out": True, **failure}
    with patch(
        "knowledge_engine.storage.elasticsearch_backend.Elasticsearch",
        return_value=client,
    ):
        with pytest.raises(RuntimeError) as caught:
            ElasticsearchBackend({"url": "http://elasticsearch:9200"}).delete_document(
                "1", "11"
            )
    assert not isinstance(caught.value, ExternalEngineCleanupError)
