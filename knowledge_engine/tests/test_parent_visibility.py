# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Parent expansion must retain the retrieved document's identity."""

from unittest.mock import MagicMock

import pytest

from knowledge_engine.query import QueryExecutor
from shared.models import RetrievalScope


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "parent_metadata",
    [
        {"knowledge_id": "1", "doc_ref": "12"},
        {"knowledge_id": "2", "doc_ref": "11"},
        {"knowledge_id": "1"},
        {"doc_ref": "11"},
        {},
    ],
)
async def test_query_does_not_expand_a_parent_from_another_document(
    parent_metadata: dict[str, str],
) -> None:
    storage = MagicMock()
    storage.retrieve.return_value = {
        "records": [
            {
                "content": "permitted child",
                "metadata": {
                    "knowledge_id": "1",
                    "doc_ref": "11",
                    "chunk_strategy": "hierarchical",
                    "parent_node_id": "parent-1",
                },
            }
        ]
    }
    storage.get_parent_nodes.return_value = {
        "parent-1": {"content": "foreign parent", "metadata": parent_metadata}
    }
    result = await QueryExecutor(storage_backend=storage, embed_model=object()).execute(
        knowledge_id="1",
        query="question",
        retrieval_config={"retrieval_mode": "vector"},
        scope=RetrievalScope(document_ids=[11]),
    )

    assert [record["content"] for record in result["records"]] == ["permitted child"]
    assert result["records"][0]["metadata"]["doc_ref"] == "11"
