# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Compatibility wrapper for lifecycle helpers."""

from app.services.chat.trigger.lifecycle import (
    collect_completed_result,
    persist_completed_result,
)

__all__ = ["collect_completed_result", "persist_completed_result"]
