# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Embedding helpers for knowledge_engine."""

from __future__ import annotations

from typing import Any

from knowledge_engine.lazy_exports import lazy_export_names, resolve_lazy_export

# ``custom`` and ``factory`` import llama-index. Keeping the exports lazy lets
# metadata-only callers import ``capabilities`` or ``contract`` without loading
# the execution kernel.
_LAZY_EXPORTS = {
    "CustomEmbedding": "knowledge_engine.embedding.custom",
    "EmbeddingDimensionMismatchError": "knowledge_engine.embedding.errors",
    "create_embedding_model_from_runtime_config": "knowledge_engine.embedding.factory",
}

__all__ = lazy_export_names(_LAZY_EXPORTS)


def __getattr__(name: str) -> Any:
    return resolve_lazy_export(__name__, _LAZY_EXPORTS, name)


def __dir__() -> list[str]:
    return lazy_export_names(_LAZY_EXPORTS)
