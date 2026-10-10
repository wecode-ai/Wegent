# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Single source of truth for the RAG execution dependencies of the Backend.

The execution kernel (wegent-knowledge-engine) and the runtime service
(wegent-knowledge-runtime) declare these. The Backend only routes retrieval, so
it must neither declare the distributions nor import the modules.
"""

from __future__ import annotations

# The execution kernel itself.
EXECUTION_KERNEL_DISTRIBUTION = "wegent-knowledge-engine"

# Distribution names as they appear in pyproject.toml dependency lists.
EXECUTION_KERNEL_DISTRIBUTIONS = (
    "llama-index-core",
    "llama-index-vector-stores-elasticsearch",
    "llama-index-vector-stores-qdrant",
    "llama-index-vector-stores-milvus",
    "llama-index-embeddings-openai",
    "llama-index-readers-file",
    "pymilvus",
    "qdrant-client",
    "elasticsearch",
    "docx2txt",
)

# Module prefixes that those distributions provide.
EXECUTION_KERNEL_MODULES = (
    "llama_index",
    "pymilvus",
    "qdrant_client",
    "elasticsearch",
    "docx2txt",
)
