# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Event type definitions for local executor mode.

Protocol aligned with LocalDeviceClient for device-based communication.
"""


class DeviceEvents:
    """Device lifecycle events."""

    REGISTER = "device:register"
    HEARTBEAT = "device:heartbeat"


class TaskEvents:
    """Task execution events."""

    EXECUTE = "task:execute"
    PROGRESS = "task:progress"
    RESULT = "task:result"
    CANCEL = "task:cancel"
    CLOSE_SESSION = "task:close-session"


class SkillEvents:
    """Skill-related events."""

    SYNC = "skill:sync"  # Backend -> Executor: sync new skills to sandbox


class ChatEvents:
    """Chat streaming events."""

    MESSAGE = "chat:message"
    CHUNK = "chat:chunk"
    DONE = "chat:done"
    START = "chat:start"
    ERROR = "chat:error"
