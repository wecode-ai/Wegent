# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Chat Shell Streaming - Stream Response Handling.

This module provides streaming response handling for Chat Shell:
- SSE streaming handler
- Local stream adapter (for embedded deployment)
"""

from .sse_handler import SSEStreamingHandler

__all__ = ["SSEStreamingHandler"]
