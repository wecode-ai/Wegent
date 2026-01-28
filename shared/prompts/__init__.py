# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Shared prompt templates module."""

from .knowledge_base import KB_PROMPT_RELAXED, KB_PROMPT_STRICT

__all__ = [
    "KB_PROMPT_STRICT",
    "KB_PROMPT_RELAXED",
]
