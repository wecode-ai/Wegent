# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Shared result models.

This module contains small, reusable dataclasses that are shared across
backend and chat_shell packages.

All comments must be written in English.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class KnowledgeBaseToolsResult:
    """Result container for knowledge base tool preparation."""

    extra_tools: list
    enhanced_system_prompt: str
    kb_meta_prompt: str
