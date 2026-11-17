# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Scoped Elasticsearch cleanup requires a fully completed SDK response."""

from typing import Any

from elasticsearch import Elasticsearch

from shared.knowledge_cleanup import ExternalEngineCleanupError


def delete_matching_chunks(
    client: Elasticsearch, *, index_name: str, filters: list[dict[str, Any]]
) -> int:
    if not client.indices.exists(index=index_name):
        return 0
    result = client.delete_by_query(
        index=index_name, query={"bool": {"filter": filters}}, refresh=True
    )
    if result.get("failures") or result.get("version_conflicts", 0):
        raise RuntimeError("External index cleanup was only partially completed")
    if result.get("timed_out") is True:
        raise ExternalEngineCleanupError("elasticsearch", "timeout")
    deleted = result.get("deleted")
    if type(deleted) is not int or deleted < 0:
        raise RuntimeError("External index cleanup returned an invalid deletion count")
    return deleted
