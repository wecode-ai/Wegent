# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Shared enumerations for database models."""

from enum import Enum as PyEnum


class SubtaskStatus(str, PyEnum):
    """Subtask execution status."""

    PENDING = "PENDING"
    RUNNING = "RUNNING"
    COMPLETED = "COMPLETED"
    FAILED = "FAILED"
    CANCELLED = "CANCELLED"
    DELETE = "DELETE"
    PENDING_CONFIRMATION = "PENDING_CONFIRMATION"  # Pipeline stage completed, waiting for user confirmation


class SubtaskRole(str, PyEnum):
    """Subtask message role."""

    USER = "USER"
    ASSISTANT = "ASSISTANT"


class SenderType(str, PyEnum):
    """Sender type for group chat messages."""

    USER = "USER"  # Message sent by a user
    TEAM = "TEAM"  # Message sent by the AI team/agent
    SYSTEM = "SYSTEM"  # System notification message (e.g., KB binding)


class ContextType(str, PyEnum):
    """Context type enumeration."""

    ATTACHMENT = "attachment"
    KNOWLEDGE_BASE = "knowledge_base"
    TABLE = "table"


class ContextStatus(str, PyEnum):
    """Context processing status."""

    PENDING = "pending"
    UPLOADING = "uploading"
    PARSING = "parsing"
    READY = "ready"
    FAILED = "failed"
