# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

from typing import Any


def _merge_single_parent_record(
    record: dict[str, Any],
    parent_record: dict[str, Any],
    parent_node_id: str,
) -> dict[str, Any]:
    merged_metadata = dict(parent_record.get("metadata") or {})
    merged_metadata["parent_node_id"] = parent_node_id

    return {
        **record,
        "content": parent_record.get("content", record.get("content", "")),
        "title": parent_record.get("title", record.get("title", "")),
        "metadata": merged_metadata,
    }


def _record_score(record: dict[str, Any]) -> float:
    score = record.get("score")
    return float(score) if isinstance(score, int | float) else float("-inf")


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
    hierarchical_positions: dict[str, int] = {}

    for record in records:
        metadata = dict(record.get("metadata") or {})
        parent_node_id = metadata.get("parent_node_id")
        parent_record = parent_records.get(parent_node_id or "")
        if metadata.get("chunk_strategy") != "hierarchical" or parent_record is None:
            merged_records.append(record)
            continue

        merged_record = _merge_single_parent_record(
            record, parent_record, parent_node_id
        )
        existing_position = hierarchical_positions.get(parent_node_id)
        if existing_position is None:
            hierarchical_positions[parent_node_id] = len(merged_records)
            merged_records.append(merged_record)
            continue

        if _record_score(merged_record) > _record_score(
            merged_records[existing_position]
        ):
            merged_records[existing_position] = merged_record

    return merged_records
