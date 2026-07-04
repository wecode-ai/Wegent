# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from typing import Any

from llama_index.core.schema import BaseNode, TextNode

from knowledge_engine.storage.base import BaseStorageBackend


class _DummyStorageBackend(BaseStorageBackend):
    def create_vector_store(self, index_name: str):
        raise NotImplementedError

    def index_with_metadata(self, nodes, chunk_metadata, embed_model, **kwargs):
        raise NotImplementedError

    def retrieve(
        self,
        knowledge_id: str,
        query: str,
        embed_model,
        retrieval_setting: dict[str, Any],
        scope=None,
        metadata_condition=None,
        **kwargs,
    ):
        raise NotImplementedError

    def delete_document(self, knowledge_id: str, doc_ref: str, **kwargs):
        raise NotImplementedError

    def delete_knowledge(self, knowledge_id: str, **kwargs):
        raise NotImplementedError

    def drop_knowledge_index(self, knowledge_id: str, **kwargs):
        raise NotImplementedError

    def get_document(self, knowledge_id: str, doc_ref: str, **kwargs):
        raise NotImplementedError

    def list_documents(
        self, knowledge_id: str, page: int = 1, page_size: int = 20, **kwargs
    ):
        raise NotImplementedError

    def test_connection(self) -> bool:
        raise NotImplementedError

    def get_all_chunks(
        self,
        knowledge_id: str,
        max_chunks: int = 10000,
        metadata_condition=None,
        **kwargs,
    ):
        raise NotImplementedError


def test_prepare_nodes_for_embedding_uses_retrieval_text_without_losing_display_text():
    backend = _DummyStorageBackend({})
    node = TextNode(
        text="Q: full question\n\nA: full answer",
        metadata={
            "retrieval_text": "Question: full question\nAnswer summary: short",
            "display_text": "Q: full question\n\nA: full answer",
        },
    )

    [prepared] = backend.prepare_nodes_for_embedding([node])

    assert prepared is not node
    assert prepared.text == "Question: full question\nAnswer summary: short"
    assert prepared.metadata["display_text"] == "Q: full question\n\nA: full answer"
    assert (
        backend.get_node_display_text(prepared) == "Q: full question\n\nA: full answer"
    )


def test_prepare_nodes_for_embedding_leaves_plain_nodes_unchanged():
    backend = _DummyStorageBackend({})
    node: BaseNode = TextNode(text="ordinary chunk", metadata={})

    [prepared] = backend.prepare_nodes_for_embedding([node])

    assert prepared is node
    assert backend.get_node_display_text(prepared) == "ordinary chunk"
