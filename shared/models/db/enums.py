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
    SELECTED_DOCUMENTS = "selected_documents"  # Selected documents from notebook mode for direct injection


class ContextStatus(str, PyEnum):
    """Context processing status.

    For knowledge_base type contexts:
    - PENDING: Retrieval not yet executed
    - READY: Retrieval successful with results
    - EMPTY: Retrieval successful but no results found
    - FAILED: Retrieval execution failed
    """

    PENDING = "pending"
    UPLOADING = "uploading"
    PARSING = "parsing"
    READY = "ready"
    FAILED = "failed"
    EMPTY = "empty"  # Retrieval successful but no results


class InjectionMode(str, PyEnum):
    """Knowledge base content injection mode.

    - DIRECT_INJECTION: All KB content injected directly into context
    - RAG_RETRIEVAL: Content retrieved via RAG (similarity search)
    """

    DIRECT_INJECTION = "direct_injection"
    RAG_RETRIEVAL = "rag_retrieval"


class QueueVisibility(str, PyEnum):
    """Work queue visibility levels."""

    PRIVATE = "private"  # Only owner can send messages
    PUBLIC = "public"  # Any logged-in user can send messages
    GROUP_VISIBLE = "group_visible"  # Only group members can send messages
    INVITE_ONLY = "invite_only"  # Only users with invite code can send messages


class QueueMessageStatus(str, PyEnum):
    """Queue message processing status."""

    UNREAD = "unread"
    READ = "read"
    PROCESSING = "processing"
    PROCESSED = "processed"
    ARCHIVED = "archived"


class QueueMessagePriority(str, PyEnum):
    """Queue message priority levels."""

    LOW = "low"
    NORMAL = "normal"
    HIGH = "high"


class TriggerMode(str, PyEnum):
    """Auto-processing trigger mode."""

    IMMEDIATE = "immediate"  # Process immediately when received
    MANUAL = "manual"  # Only process when user triggers
    SCHEDULED = "scheduled"  # Process at scheduled intervals
    CONDITION_BASED = "condition_based"  # Process based on conditions
