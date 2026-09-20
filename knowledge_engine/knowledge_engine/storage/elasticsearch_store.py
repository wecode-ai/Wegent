# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Elasticsearch store adapter that keeps the score Elasticsearch returned.

LlamaIndex's ``ElasticsearchStore`` maps every hit's ``_score`` through
``_to_llama_similarities``, which min-maxes the batch before the caller sees
it. That destroys the score ratio the shared scoring rule compares against a
threshold, and the mapping happens inside the vendor's ``aquery`` with no hook
to replace it.

This subclass keeps the whole vendor query path - retrieval strategy, filters,
``custom_query`` and hit-to-node conversion - and replaces only that
post-processing step: each record's similarity is the ``_score``
Elasticsearch returned, leaving the backend free to scale it the same way on
every engine.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from llama_index.core.bridge.pydantic import PrivateAttr
from llama_index.core.vector_stores.types import (
    VectorStoreQuery,
    VectorStoreQueryResult,
)
from llama_index.vector_stores.elasticsearch import ElasticsearchStore


class _HitScoreRecorder:
    """Delegates to one vendor store and records the hits a search returns.

    The vendor store is not read-only through this seam: its ``add`` path sets
    ``num_dimensions`` on the object it holds before indexing, so attribute
    writes are forwarded as well. Reads and writes therefore stay transparent
    and only ``search`` is observed.
    """

    _OWN_ATTRIBUTES = frozenset({"_inner", "_sink"})

    def __init__(self, inner: Any, sink: List[float]) -> None:
        self._inner = inner
        self._sink = sink

    def __setattr__(self, name: str, value: Any) -> None:
        if name in self._OWN_ATTRIBUTES:
            object.__setattr__(self, name, value)
        else:
            setattr(self._inner, name, value)

    def __getattr__(self, name: str) -> Any:
        return getattr(self._inner, name)

    async def search(self, *args: Any, **kwargs: Any) -> List[Dict[str, Any]]:
        hits = await self._inner.search(*args, **kwargs)
        self._sink.extend(float(hit["_score"]) for hit in hits)
        return hits


class RawScoreElasticsearchStore(ElasticsearchStore):
    """ElasticsearchStore that reports the raw ``_score`` of each hit."""

    _raw_scores: List[float] = PrivateAttr(default_factory=list)

    def __init__(self, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self._store = _HitScoreRecorder(self._store, self._raw_scores)

    async def aquery(
        self,
        query: VectorStoreQuery,
        custom_query: Optional[Any] = None,
        es_filter: Optional[List[Dict[str, Any]]] = None,
        metadata_keyword_suffix: str = ".keyword",
        **kwargs: Any,
    ) -> VectorStoreQueryResult:
        self._raw_scores.clear()
        result = await super().aquery(
            query,
            custom_query,
            es_filter,
            metadata_keyword_suffix,
            **kwargs,
        )
        if result.nodes:
            if len(self._raw_scores) != len(result.nodes):
                raise RuntimeError(
                    "Elasticsearch returned nodes without recorded raw scores; "
                    "the pinned llama-index store layout changed."
                )
            result.similarities = list(self._raw_scores)
        return result
