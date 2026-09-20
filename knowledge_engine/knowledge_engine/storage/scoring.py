# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Shared score semantics for retrieval result sets.

Vector scores carry an absolute scale: COSINE similarity means the same thing
across queries and collections, so a fixed threshold is meaningful. Keyword
and hybrid scores do not. BM25 depends on the corpus, the analyzer and the
document length, and a fused score depends on the ranker and its weights.
Those modes are only comparable inside the result set they came from, so every
backend reports them on the same relative scale: the set's maximum is 1.0.

The rescaling happens before the threshold runs, so one ``score_threshold``
means "at least this share of the top hit" on every backend and in the modes
that share the relative scale. The fusion algorithms themselves are not
unified: this module fixes what a reported score means, not how it is ranked.

The input must still be the score the engine returned. An adapter that
pre-scales the batch before this rule runs destroys the ratio: the
Elasticsearch store therefore keeps the raw ``_score``
(``knowledge_engine.storage.elasticsearch_store``) and recovers the absolute
cosine of a vector hit from the knn score before the threshold sees it.
"""

from __future__ import annotations

from typing import Sequence

# Retrieval modes whose scores are only meaningful relative to the result set
# they came from. Vector keeps its raw COSINE value.
RELATIVE_SCORE_RETRIEVAL_MODES = frozenset({"keyword", "hybrid"})


def normalize_scores_to_max(scores: Sequence[float]) -> list[float]:
    """Rescale one result set's scores so its maximum becomes 1.0.

    A non-positive maximum leaves the scores unchanged: there is no positive
    scale to divide by, and the threshold still sees the values the server
    returned.
    """
    values = [float(score) for score in scores]
    max_score = max(values, default=0.0)
    if max_score <= 0.0:
        return values
    return [value / max_score for value in values]
