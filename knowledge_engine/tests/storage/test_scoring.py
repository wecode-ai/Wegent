# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for the shared result-set score normalization."""

from knowledge_engine.storage.scoring import (
    RELATIVE_SCORE_RETRIEVAL_MODES,
    normalize_scores_to_max,
)


def test_keyword_and_hybrid_are_the_relative_score_modes():
    assert RELATIVE_SCORE_RETRIEVAL_MODES == frozenset({"keyword", "hybrid"})


def test_scores_are_rescaled_so_the_top_hit_is_one():
    assert normalize_scores_to_max([3.0, 1.5, 0.0]) == [1.0, 0.5, 0.0]


def test_a_non_positive_maximum_leaves_the_scores_unchanged():
    """Without a positive scale the server's values pass through untouched."""
    assert normalize_scores_to_max([0.0, -0.2]) == [0.0, -0.2]


def test_an_empty_result_set_has_no_scores_to_rescale():
    assert normalize_scores_to_max([]) == []
