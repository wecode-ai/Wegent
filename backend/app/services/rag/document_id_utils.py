# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Helpers for extracting knowledge document IDs from retrieval records."""

from typing import Any, Mapping, Optional


def parse_positive_int(value: Any) -> Optional[int]:
    """Parse positive integer values without accepting bools."""
    if type(value) is int and value > 0:
        return value
    if isinstance(value, str):
        normalized = value[4:] if value.startswith("doc_") else value
        if not normalized.isdigit():
            return None
        parsed = int(normalized)
        return parsed if parsed > 0 else None
    return None


def extract_document_id(record: Mapping[str, Any]) -> Optional[int]:
    """Extract a numeric document ID from a retrieval/search record."""
    metadata = record.get("metadata") or {}
    if not isinstance(metadata, Mapping):
        metadata = {}

    return (
        parse_positive_int(record.get("document_id"))
        or parse_positive_int(metadata.get("document_id"))
        or parse_positive_int(record.get("doc_ref"))
        or parse_positive_int(metadata.get("doc_ref"))
    )
