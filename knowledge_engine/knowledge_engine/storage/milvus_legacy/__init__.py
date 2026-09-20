# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Legacy Milvus storage adapter.

The adapter behind ``storageConfig.type: milvus``. It serves the collections
the online main branch built, so an existing knowledge base keeps its index,
retrieval, update, read, parent-node, purge and drop behaviour while the Milvus
V2 adapter serves new collections under its own type. Its implementation is
the main branch's, split across this package only to keep every module within
the repository's file size rule.
"""

from knowledge_engine.storage.milvus_legacy.backend import LegacyMilvusBackend

__all__ = ["LegacyMilvusBackend"]
