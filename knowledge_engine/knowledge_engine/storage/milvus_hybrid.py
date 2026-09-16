# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Milvus hybrid retrieval: weights, score mappings and fusion.

This module owns the hybrid scoring contract only. It never talks to Milvus
and never resolves retrieval text, so the adapter above it keeps the storage
lifecycle while this module holds one concern: turning two routes' raw
database scores into one reproducible fused score.

The fusion deliberately does not use the server-side ``WeightedRanker``. That
ranker min-max normalizes each route against its own candidate set, so a row's
score depends on which other rows happened to match instead of on the row
itself. Measured directly on Milvus v2.5.4 with pymilvus 2.6.3, holding both
route limits and one row's raw scores fixed and adding only filler rows weaker
than it on *both* routes (dense 1.0 vs. best filler 0.4268, sparse 1.511496
vs. filler 0.0858): that row's fused score moved from 0.827828 to 0.888372.
The fixed mappings here keep the same row at the same score regardless of the
candidate set.
"""

from __future__ import annotations

import math
from typing import Any, Dict, Optional, Sequence, Tuple

from knowledge_engine.storage.milvus_native import ID_FIELD

DEFAULT_VECTOR_WEIGHT = 0.7
DEFAULT_KEYWORD_WEIGHT = 0.3


def resolve_hybrid_weights(retrieval_setting: Dict[str, Any]) -> Tuple[float, float]:
    """Resolve the configured vector/keyword weights into a normalized pair.

    The weights are shares of one fusion, so both configured weights are
    normalized to sum to one, a lone weight keeps its own share and the other
    branch takes the remainder, and an absent pair falls back to the product
    default 0.7/0.3. Values that cannot describe a share fail explicitly
    instead of silently switching the mode.
    """
    vector_weight = _hybrid_weight("vector_weight", retrieval_setting)
    keyword_weight = _hybrid_weight("keyword_weight", retrieval_setting)

    if vector_weight is not None and keyword_weight is not None:
        total = vector_weight + keyword_weight
        if total <= 0.0:
            raise ValueError(
                "hybrid retrieval requires a positive vector_weight or "
                "keyword_weight; both are zero."
            )
        return vector_weight / total, keyword_weight / total

    if vector_weight is not None:
        if vector_weight > 1.0:
            raise ValueError("hybrid retrieval requires vector_weight <= 1.")
        return vector_weight, 1.0 - vector_weight

    if keyword_weight is not None:
        if keyword_weight > 1.0:
            raise ValueError("hybrid retrieval requires keyword_weight <= 1.")
        return 1.0 - keyword_weight, keyword_weight

    return DEFAULT_VECTOR_WEIGHT, DEFAULT_KEYWORD_WEIGHT


def _hybrid_weight(name: str, retrieval_setting: Dict[str, Any]) -> Optional[float]:
    raw_value = retrieval_setting.get(name)
    if raw_value is None:
        return None
    if isinstance(raw_value, bool) or not isinstance(raw_value, (int, float)):
        raise ValueError(f"hybrid retrieval requires a numeric {name}.")
    value = float(raw_value)
    if not math.isfinite(value):
        raise ValueError(f"hybrid retrieval requires a finite {name}.")
    if value < 0.0:
        raise ValueError(f"hybrid retrieval requires a non-negative {name}.")
    return value


def dense_relevance_score(raw_score: float) -> float:
    """Map a raw COSINE score onto the shared 0..1 relevance scale.

    The mapping is fixed and monotonic (``(1 + cos) / 2``) instead of being
    derived from the candidate set. Pure vector retrieval keeps the raw cosine
    score; only the hybrid fusion needs a bounded share.
    """
    if not math.isfinite(raw_score):
        return 0.0
    return min(1.0, max(0.0, (1.0 + raw_score) / 2.0))


def keyword_relevance_score(raw_score: float) -> float:
    """Map a non-negative BM25 score onto the shared 0..1 relevance scale.

    The mapping is fixed and monotonic (``score / (1 + score)``) instead of
    being derived from the candidate set, so the same document keeps the same
    score regardless of which other documents matched.
    """
    if not math.isfinite(raw_score) or raw_score <= 0.0:
        return 0.0
    return raw_score / (1.0 + raw_score)


def fuse_hybrid_hits(
    *,
    dense_hits: Sequence[Dict[str, Any]],
    keyword_hits: Sequence[Dict[str, Any]],
    vector_weight: float,
    keyword_weight: float,
    top_k: int,
) -> Tuple[list[Dict[str, Any]], Dict[Any, float]]:
    """Fuse the two routes' raw scores into ranked hits and their scores.

    Each route contributes its raw database score through its own fixed
    monotonic mapping and the two mapped shares are combined with the
    normalized weights. A row both routes recalled sums both shares; a row only
    one route recalled keeps that route's share alone.

    The returned scores are the same fusion the threshold compares against, so
    the reported score and the gate can never disagree about which scale they
    are on.
    """
    scores: Dict[Any, float] = {}
    evidence: Dict[Any, Dict[str, Any]] = {}
    for hits, mapper, weight in (
        (dense_hits, dense_relevance_score, vector_weight),
        (keyword_hits, keyword_relevance_score, keyword_weight),
    ):
        for hit in hits:
            mapped = mapper(float(hit.get("__score__", 0.0)))
            row_id = hit.get(ID_FIELD)
            evidence.setdefault(row_id, hit)
            scores[row_id] = scores.get(row_id, 0.0) + weight * mapped

    ranked = sorted(scores.items(), key=lambda entry: entry[1], reverse=True)[:top_k]
    ranked_scores = dict(ranked)
    return [evidence[row_id] for row_id, _ in ranked], ranked_scores
