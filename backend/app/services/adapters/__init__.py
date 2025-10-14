# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Adapters for converting between public tables and original API interfaces.

This module contains various adapter classes that handle data transformation
between the new public tables (public_models, public_shells, etc.) and the
original API response formats.
"""

from .public_model import public_model_service, ModelAdapter, MockModel
from .public_shell import public_shell_service, AgentAdapter, MockAgent
from .bot_kinds import bot_kinds_service

__all__ = [
    "ModelAdapter",
    "MockModel",
    "AgentAdapter",
    "MockAgent",
    "public_model_service",
    "public_shell_service",
    "bot_kinds_service",
]