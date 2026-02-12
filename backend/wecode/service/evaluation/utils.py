# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Utility functions for the evaluation module.
"""

import uuid
from datetime import datetime


def generate_version() -> str:
    """
    Generate a unique version string.

    Format: YYYYMMDD_HHmmss_XXXX
    - YYYYMMDD_HHmmss: UTC timestamp
    - XXXX: First 4 characters of UUID

    Returns:
        Version string like "20240115_143000_a1b2"
    """
    timestamp = datetime.utcnow().strftime("%Y%m%d_%H%M%S")
    unique_id = uuid.uuid4().hex[:4]
    return f"{timestamp}_{unique_id}"
