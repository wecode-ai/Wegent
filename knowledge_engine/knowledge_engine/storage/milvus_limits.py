# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Shared Milvus write-limit validation without importing its SDK."""

from typing import Any

DEFAULT_MAX_BATCH_BYTES = 1024 * 1024
DEFAULT_BATCH_HEADROOM_BYTES = 64 * 1024


def validate_milvus_write_config(options: dict[str, Any]) -> None:
    """Validate byte limits and an explicitly configured row limit."""
    max_bytes = options.get("max_batch_bytes", DEFAULT_MAX_BATCH_BYTES)
    headroom = options.get("batch_headroom_bytes", DEFAULT_BATCH_HEADROOM_BYTES)
    checks = [
        ("max_batch_bytes", max_bytes, 1),
        ("batch_headroom_bytes", headroom, 0),
    ]
    if "batch_size" in options:
        checks.append(("batch_size", options["batch_size"], 1))
    for name, value, minimum in checks:
        if type(value) is not int or value < minimum:
            raise ValueError(f"Milvus {name} must be an integer >= {minimum}")
    if headroom >= max_bytes:
        raise ValueError(
            "Milvus batch_headroom_bytes must be less than max_batch_bytes"
        )


def validate_batch_limits(max_bytes: int, headroom: int, max_rows: int) -> None:
    """Validate the concrete limits selected by a native write client."""
    validate_milvus_write_config(
        {
            "max_batch_bytes": max_bytes,
            "batch_headroom_bytes": headroom,
            "batch_size": max_rows,
        }
    )
