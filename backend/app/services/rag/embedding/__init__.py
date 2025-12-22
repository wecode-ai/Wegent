# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Embedding module for RAG functionality.
"""

from app.services.rag.embedding.custom import CustomEmbedding
from app.services.rag.embedding.factory import create_embedding_model_from_crd

__all__ = [
    "create_embedding_model_from_crd",
    "CustomEmbedding",
]
