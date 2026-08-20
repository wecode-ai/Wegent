"""Tests for the safe retrieval-capability derivation policy."""

import pytest

from app.services.knowledge.retrieval_capabilities import (
    derive_retrieval_capabilities,
)


@pytest.mark.parametrize(
    ("config", "expected"),
    [
        (
            {"retrieval_mode": "vector"},
            {
                "retrieval_mode": "vector",
                "semantic_query": False,
                "keywords": False,
                "phrases": False,
            },
        ),
        (
            {"retrieval_mode": "hybrid"},
            {
                "retrieval_mode": "hybrid",
                "semantic_query": True,
                "keywords": True,
                "phrases": True,
            },
        ),
        (
            {"retrieval_mode": "keyword"},
            {
                "retrieval_mode": "keyword",
                "semantic_query": False,
                "keywords": True,
                "phrases": True,
            },
        ),
        (
            None,
            {
                "retrieval_mode": None,
                "semantic_query": False,
                "keywords": False,
                "phrases": False,
            },
        ),
        (
            {"retrieval_mode": ["hybrid"]},
            {
                "retrieval_mode": None,
                "semantic_query": False,
                "keywords": False,
                "phrases": False,
            },
        ),
    ],
)
def test_derive_retrieval_capabilities(
    config: dict[str, object] | None, expected: dict[str, str | bool | None]
) -> None:
    assert derive_retrieval_capabilities(config) == expected
