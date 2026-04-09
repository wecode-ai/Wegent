# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Embedding helpers exposed at the Backend runtime boundary."""

from app.services.rag.embedding.factory import (
    create_embedding_model_from_crd,
    create_embedding_model_from_runtime_config,
)
from knowledge_engine.embedding.custom import CustomEmbedding

__all__ = [
    "create_embedding_model_from_crd",
    "create_embedding_model_from_runtime_config",
    "CustomEmbedding",
]
