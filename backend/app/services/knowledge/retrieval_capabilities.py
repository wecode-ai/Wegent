"""Safe, derived retrieval capabilities exposed to Agents and clients."""

from __future__ import annotations

from typing import Any


def derive_retrieval_capabilities(
    retrieval_config: dict[str, Any] | None,
) -> dict[str, Any]:
    """Describe optional query hints that should be advertised to agents.

    The returned value intentionally contains no resource identifiers or connection
    settings. It is safe for prompts and knowledge-base discovery responses.
    """
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
        # The caller's query already drives vector retrieval. Do not ask an agent
        # to construct a redundant semantic rewrite for vector or hybrid search.
        "semantic_query": False,
        "keywords": mode in {"keyword", "hybrid"},
        "phrases": mode in {"keyword", "hybrid"},
    }
