#!/usr/bin/env python

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# -*- coding: utf-8 -*-

"""
Callback module for executor.

Uses OpenAI Responses API format from shared.models.responses_api for all callbacks.
This ensures consistency with SSE mode (chat_shell) event format.
"""

from executor.callback.callback_client import CallbackClient
from executor.callback.callback_handler import (
    send_cancelled_event,
    send_chunk_event,
    send_done_event,
    send_error_event,
    send_progress_event,
    send_start_event,
    send_thinking_event,
    send_tool_result_event,
    send_tool_start_event,
)

__all__ = [
    # Client
    "CallbackClient",
    # OpenAI Responses API format functions
    "send_start_event",
    "send_progress_event",
    "send_chunk_event",
    "send_thinking_event",
    "send_tool_start_event",
    "send_tool_result_event",
    "send_done_event",
    "send_error_event",
    "send_cancelled_event",
]
