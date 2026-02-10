#!/usr/bin/env python

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# -*- coding: utf-8 -*-

"""
Callback module for executor.

Uses unified ExecutionEvent format from shared.models.execution.
All legacy callback functions have been removed.
"""

from executor.callback.callback_client import CallbackClient
from executor.callback.callback_handler import (
    send_cancelled_event,
    send_chunk_event,
    send_done_event,
    send_error_event,
    send_execution_event,
    send_progress_event,
    send_start_event,
)

__all__ = [
    # Client
    "CallbackClient",
    # Unified ExecutionEvent-based functions
    "send_execution_event",
    "send_start_event",
    "send_progress_event",
    "send_chunk_event",
    "send_done_event",
    "send_error_event",
    "send_cancelled_event",
]
