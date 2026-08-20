"""Derive safe retrieval capability metadata for runtime consumers."""

from __future__ import annotations

from typing import Any

VALID_RETRIEVAL_MODES = frozenset({"vector", "keyword", "hybrid"})


def derive_retrieval_capabilities(
    retrieval_config: dict[str, Any] | None,
) -> dict[str, Any]:
    """Describe optional query hints that are useful for a retrieval mode."""
    config = retrieval_config if isinstance(retrieval_config, dict) else {}
    mode = config.get("retrieval_mode")
    if not isinstance(mode, str) or mode not in VALID_RETRIEVAL_MODES:
        return {
            "retrieval_mode": None,
            "semantic_query": False,
            "keywords": False,
            "phrases": False,
        }

    return {
        "retrieval_mode": mode,
        "semantic_query": mode == "hybrid",
        "keywords": mode in {"keyword", "hybrid"},
        "phrases": mode in {"keyword", "hybrid"},
    }
