# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Pure Redis payload codec operations for chat streaming state."""

from __future__ import annotations

import json
from typing import Any, Dict, List, Optional


def decode_redis_text(value: Any) -> str:
    """Decode a Redis value into text."""
    if value is None:
        return ""
    if isinstance(value, bytes):
        return value.decode("utf-8")
    return str(value)


def decode_block_id(value: Any) -> str:
    """Decode a Redis block identifier."""
    return value.decode("utf-8") if isinstance(value, bytes) else str(value)


def serialize_stream_done(result: Optional[Dict[str, Any]]) -> str:
    """Serialize the terminal streaming message."""
    return json.dumps({"__type__": "STREAM_DONE", "result": result})


def serialize_block(block: Dict[str, Any]) -> str:
    """Serialize one block for Redis storage."""
    return json.dumps(block)


def decode_block_metadata(
    blocks_raw: List[Any],
    content_key_field: str,
) -> tuple[List[Dict[str, Any]], List[tuple[int, str]]]:
    """Decode ordered block metadata and collect external content references."""
    blocks: List[Dict[str, Any]] = []
    content_refs: List[tuple[int, str]] = []
    for block_json in blocks_raw:
        block = json.loads(block_json)
        content_key = block.get(content_key_field)
        if isinstance(content_key, str):
            content_refs.append((len(blocks), content_key))
        blocks.append(block)
    return blocks, content_refs


def hydrate_block_content(
    blocks: List[Dict[str, Any]],
    content_refs: List[tuple[int, str]],
    content_values: List[Any],
    content_key_field: str,
) -> List[Dict[str, Any]]:
    """Hydrate external block content while preserving list order."""
    for (block_index, _), content_value in zip(content_refs, content_values):
        blocks[block_index]["content"] = decode_redis_text(content_value)
    for block in blocks:
        block.pop(content_key_field, None)
    return blocks


def extract_block_content_keys(
    blocks_raw: List[Any],
    content_key_field: str,
) -> List[str]:
    """Extract content keys from serialized block metadata."""
    content_keys: List[str] = []
    for block_json in blocks_raw:
        try:
            block = json.loads(block_json)
        except Exception:
            continue
        content_key = block.get(content_key_field)
        if isinstance(content_key, str):
            content_keys.append(content_key)
    return content_keys


def prepare_block_upsert(
    blocks_raw: List[Any],
    block_id: str,
    block: Dict[str, Any],
    content_key_field: str,
) -> tuple[Optional[int], str, Optional[str], Any]:
    """Find an existing block and prepare its ordered Redis write payload."""
    existing_index: Optional[int] = None
    existing_block: Optional[Dict[str, Any]] = None
    for index, block_json in enumerate(blocks_raw):
        candidate = json.loads(block_json)
        if candidate.get("id") == block_id:
            existing_index = index
            existing_block = candidate
            break

    block_to_store = block.copy()
    content_key = (existing_block or {}).get(content_key_field)
    content_value: Any = None
    if isinstance(content_key, str):
        content_value = block_to_store.get("content", "")
        block_to_store[content_key_field] = content_key
        block_to_store["content"] = ""

    return existing_index, json.dumps(block_to_store), content_key, content_value


def finalize_block(
    blocks_raw: List[Any],
    block_id: str,
    done_status: str,
) -> Optional[tuple[int, str]]:
    """Find a block by id and serialize its terminal status update."""
    for index, block_json in enumerate(blocks_raw):
        block = json.loads(block_json)
        if block.get("id") == block_id:
            block["status"] = done_status
            return index, json.dumps(block)
    return None
