# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Knowledge base prompt templates.

This module re-exports shared KB prompts for backward compatibility.
"""

# Import from shared module (single source of truth)
from shared.prompts import KB_PROMPT_RELAXED, KB_PROMPT_STRICT

__all__ = [
    "KB_PROMPT_STRICT",
    "KB_PROMPT_RELAXED",
]
