# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Embedding helpers for knowledge_engine."""

from knowledge_engine.embedding.custom import CustomEmbedding
from knowledge_engine.embedding.factory import (
    create_embedding_model_from_runtime_config,
)

__all__ = ["CustomEmbedding", "create_embedding_model_from_runtime_config"]
