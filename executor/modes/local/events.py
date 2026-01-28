# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Event type definitions for local executor mode.

All local executor events use 'local:' prefix to distinguish from other events.
"""


class LocalExecutorEvents:
    """Local Executor events for lifecycle management."""

    # Registration events
    REGISTER = "local:executor:register"
    UNREGISTER = "local:executor:unregister"
    HEARTBEAT = "local:executor:heartbeat"

    # Connection events
    CONNECT = "connect"
    DISCONNECT = "disconnect"
    CONNECT_ERROR = "connect_error"
    RECONNECT = "reconnect"


class LocalTaskEvents:
    """Local Executor task events."""

    # Task lifecycle events
    DISPATCH = "local:task:dispatch"
    PROGRESS = "local:task:progress"
    RESULT = "local:task:result"
    CANCEL = "local:task:cancel"


class LocalChatEvents:
    """Local Executor chat events for streaming messages."""

    # Chat events
    MESSAGE = "local:chat:message"
    CHUNK = "local:chat:chunk"
    DONE = "local:chat:done"
    START = "local:chat:start"
    ERROR = "local:chat:error"
