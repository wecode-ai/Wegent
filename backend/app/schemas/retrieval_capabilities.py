"""Safe retrieval capability metadata shared by responses and runtime context."""

from __future__ import annotations

from typing import Any


def derive_retrieval_capabilities(
    retrieval_config: dict[str, Any] | None,
) -> dict[str, Any]:
    """Describe optional query hints that are useful for a retrieval mode."""
    config = retrieval_config if isinstance(retrieval_config, dict) else {}
    mode = config.get("retrieval_mode")
    if mode not in {"vector", "keyword", "hybrid"}:
        return {
            "retrieval_mode": None,
            "semantic_query": False,
            "keywords": False,
            "phrases": False,
        }

    return {
        "retrieval_mode": mode,
        # A vector-only caller's original query is already its dense query. Hybrid
        # retrieval additionally benefits from an optional semantic rewrite.
        "semantic_query": mode == "hybrid",
        "keywords": mode in {"keyword", "hybrid"},
        "phrases": mode in {"keyword", "hybrid"},
    }
