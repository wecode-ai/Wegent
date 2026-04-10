# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

from typing import Any


def collect_parent_node_ids(records: list[dict[str, Any]]) -> list[str]:
    parent_node_ids: list[str] = []
    seen: set[str] = set()

    for record in records:
        metadata = record.get("metadata") or {}
        if metadata.get("chunk_strategy") != "hierarchical":
            continue
        parent_node_id = metadata.get("parent_node_id")
        if not parent_node_id or parent_node_id in seen:
            continue
        seen.add(parent_node_id)
        parent_node_ids.append(parent_node_id)

    return parent_node_ids


def merge_parent_records(
    records: list[dict[str, Any]],
    parent_records: dict[str, dict[str, Any]],
) -> list[dict[str, Any]]:
    merged_records: list[dict[str, Any]] = []

    for record in records:
        metadata = dict(record.get("metadata") or {})
        parent_node_id = metadata.get("parent_node_id")
        parent_record = parent_records.get(parent_node_id or "")
        if metadata.get("chunk_strategy") != "hierarchical" or parent_record is None:
            merged_records.append(record)
            continue

        merged_metadata = dict(parent_record.get("metadata") or {})
        merged_metadata["parent_node_id"] = parent_node_id

        merged_records.append(
            {
                **record,
                "content": parent_record.get("content", record.get("content", "")),
                "title": parent_record.get("title", record.get("title", "")),
                "metadata": merged_metadata,
            }
        )

    return merged_records
