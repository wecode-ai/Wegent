# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Require a readable Qdrant schema before synchronous indexing or retrieval."""

import time
from typing import Any

from llama_index.core.schema import BaseNode
from llama_index.vector_stores.qdrant import QdrantVectorStore
from pydantic import PrivateAttr
from qdrant_client.http import models
from qdrant_client.http.exceptions import UnexpectedResponse


class ReadyQdrantVectorStore(QdrantVectorStore):
    """Keep first writes from guessing vector names during collection creation."""

    _resolved_vector_size: int | None = PrivateAttr(default=None)

    def _detect_vector_format(self, collection_name: str) -> None:
        # Concurrent creation can expose a collection before its schema is readable.
        for attempt in range(5):
            try:
                info = self.client.get_collection(collection_name)
                break
            except UnexpectedResponse as error:
                if error.status_code not in (404, 500, 503) or attempt == 4:
                    raise
                time.sleep(0.1 * (attempt + 1))
        vectors = info.config.params.vectors
        if isinstance(vectors, models.VectorParams):
            name, params = "", vectors
        elif isinstance(vectors, dict):
            name = "" if "" in vectors else self.dense_vector_name
            params = vectors.get(name)
            if not isinstance(params, models.VectorParams):
                raise ValueError(f"Unsupported Qdrant vector schema: {collection_name}")
        else:
            raise ValueError(f"Missing Qdrant vector schema: {collection_name}")
        self.dense_vector_name = name
        self._legacy_vector_format = name == ""
        self._resolved_vector_size = params.size

    def add(
        self,
        nodes: list[BaseNode],
        shard_identifier: Any = None,
        **add_kwargs: Any,
    ) -> list[str]:
        if nodes:
            if not self._collection_initialized:
                self._create_collection(
                    self.collection_name, len(nodes[0].get_embedding())
                )
            if self._legacy_vector_format is None:
                self._detect_vector_format(self.collection_name)
            if any(
                len(node.get_embedding()) != self._resolved_vector_size
                for node in nodes
            ):
                raise ValueError("Qdrant embedding dimension does not match collection")
        return super().add(nodes, shard_identifier=shard_identifier, **add_kwargs)
