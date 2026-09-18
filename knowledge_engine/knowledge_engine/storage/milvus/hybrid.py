# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Hybrid retrieval weights: the one business parameter Milvus cannot guess.

The hybrid route itself is Milvus's: both branches run as one native hybrid
search and the server-side weighted ranker fuses them. This module owns only
the adapter work the storage interface cannot express - turning the configured
vector/keyword weights into the normalized share pair the ranker takes - and
never computes, normalizes or remaps a score.
"""

from __future__ import annotations

import math
from typing import Any, Dict, Optional, Tuple

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
