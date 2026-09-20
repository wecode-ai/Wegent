# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Milvus V2 storage adapter.

This adapter's implementation lives in this repository: the sibling backends
delegate to ``llama_index.vector_stores``, while this one talks to the official
synchronous PyMilvus client itself. Its row layout, index contract, RPC
surface, deletion path and parent sidecar therefore live in their own package
beside it instead of in the shared storage namespace. The frozen adapter that
serves the collections written before this physical contract is the historical
``knowledge_engine.storage.milvus_backend`` module beside it.
"""

from knowledge_engine.storage.milvus.backend import MilvusBackend

__all__ = ["MilvusBackend"]
