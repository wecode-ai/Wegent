# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Named constants of the legacy Milvus adapter.

They are declared once here because the frozen adapter is split across the
modules beside this one purely to keep every module within the repository's
file size rule.
"""

DEFAULT_EMBEDDING_DIM = 1024  # Default vector dimension (OpenAI ada-002)
MAX_QUERY_LIMIT = 10000  # Maximum records to fetch for aggregation queries
DEFAULT_TOP_K = 20  # Default top_k for retrieval
