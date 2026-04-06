# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Backward-compatible re-export of the engine Elasticsearch backend."""

from knowledge_engine.storage.elasticsearch_backend import (
    Elasticsearch,
    ElasticsearchBackend,
)

__all__ = ["ElasticsearchBackend", "Elasticsearch"]
