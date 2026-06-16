#!/usr/bin/env python

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Utilities for model API source headers."""

from typing import Optional

WECODE_SOURCE_HEADER = "wecode-source"
WEWORK_SOURCE = "wework"


def merge_anthropic_custom_headers(
    existing_headers: str,
    source: Optional[str],
) -> str:
    """Return Anthropic custom headers with the Wegent source header merged."""
    if not source:
        return existing_headers

    lines = [
        line.strip() for line in existing_headers.splitlines() if line and line.strip()
    ]
    header_prefix = f"{WECODE_SOURCE_HEADER}:"
    preserved = [line for line in lines if not line.lower().startswith(header_prefix)]
    preserved.append(f"{WECODE_SOURCE_HEADER}: {source}")
    return "\n".join(preserved)
