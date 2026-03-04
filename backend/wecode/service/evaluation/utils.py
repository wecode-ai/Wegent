# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Utility functions for the evaluation module.
"""

import re
import uuid
from datetime import datetime, timezone


def sanitize_filename(filename: str) -> str:
    """
    Sanitize filename by removing zero-width and invisible Unicode characters.

    These characters can cause issues with S3 storage and other systems:
    - U+200B: Zero Width Space
    - U+200C: Zero Width Non-Joiner
    - U+200D: Zero Width Joiner
    - U+FEFF: Zero Width No-Break Space (BOM)
    - U+2060-2064: Word Joiner and invisible operators
    - U+206A-206F: Invisible format characters

    Args:
        filename: Original filename

    Returns:
        Sanitized filename with invisible characters removed
    """
    # Pattern to match zero-width and invisible characters
    # U+200B-U+200D, U+FEFF, U+2060-U+206F
    invisible_chars_pattern = re.compile("[\u200b-\u200d\ufeff\u2060-\u206f]+")
    return invisible_chars_pattern.sub("", filename)


def generate_version() -> str:
    """
    Generate a unique version string.

    Format: YYYYMMDD_HHmmss_XXXX
    - YYYYMMDD_HHmmss: UTC timestamp
    - XXXX: First 4 characters of UUID

    Returns:
        Version string like "20240115_143000_a1b2"
    """
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    unique_id = uuid.uuid4().hex[:4]
    return f"{timestamp}_{unique_id}"
