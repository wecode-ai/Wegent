# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Adapters for Kind-based resources.

This module contains various adapter services for managing Kind resources
such as bots, models, shells, teams, and tasks.
"""

from .bot_kinds import bot_kinds_service

__all__ = [
    "bot_kinds_service",
]
