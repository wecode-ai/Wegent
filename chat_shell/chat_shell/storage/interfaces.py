"""
Storage interface definitions for chat_shell.

This module defines the abstract interfaces for storage providers.
chat_shell uses these interfaces to abstract storage dependencies,
allowing different implementations for different deployment modes:

- MemoryStore: For CLI and testing
- SQLiteStore: For CLI persistence
- RemoteStore: For calling Backend APIs
"""

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Optional


@dataclass
class Message:
    """Chat message data class."""

    role: str = ""  # "user", "assistant", "system", "tool"
    content: Any = None  # str or list (for vision/multimodal)
    id: Optional[str] = None
    name: Optional[str] = None  # for tool messages
    tool_call_id: Optional[str] = None
    tool_calls: Optional[list] = None
    created_at: Optional[str] = None
    metadata: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        """Convert to dictionary."""
        result = {
            "role": self.role,
            "content": self.content,
        }
        if self.id:
            result["id"] = self.id
        if self.name:
            result["name"] = self.name
        if self.tool_call_id:
            result["tool_call_id"] = self.tool_call_id
        if self.tool_calls:
            result["tool_calls"] = self.tool_calls
        if self.created_at:
            result["created_at"] = self.created_at
        if self.metadata:
            result["metadata"] = self.metadata
        return result

    @classmethod
    def from_dict(cls, data: dict) -> "Message":
        """Create from dictionary."""
        return cls(
            id=data.get("id"),
            role=data.get("role", ""),
            content=data.get("content"),
            name=data.get("name"),
            tool_call_id=data.get("tool_call_id"),
            tool_calls=data.get("tool_calls"),
            created_at=data.get("created_at"),
            metadata=data.get("metadata", {}),
        )


class HistoryStoreInterface(ABC):
    """
    Chat history storage interface.

    chat_shell uses this interface to:
    - CLI mode: Local storage (SQLite/Memory)
    - HTTP mode: Query history for multi-turn conversations (RemoteStore calls Backend API)
    - Package mode: History provided by caller (Backend) via messages parameter, no HistoryStore needed

    Methods:
        get_history: Get chat history for a session
        append_message: Append a message to session history
        append_messages: Batch append messages
        clear_history: Clear session history
        list_sessions: List all session IDs (for CLI)
        update_message: Update an existing message
        delete_message: Delete a message
    """

    @abstractmethod
    async def get_history(
        self,
        session_id: str,
        limit: Optional[int] = None,
        before_message_id: Optional[str] = None,
    ) -> list[Message]:
        """
        Get chat history for a session.

        Args:
            session_id: Session identifier
            limit: Maximum number of messages to return
            before_message_id: Only return messages before this ID (for pagination)

        Returns:
            List of Message objects, ordered by creation time (oldest first)
        """
        pass

    @abstractmethod
    async def append_message(
        self,
        session_id: str,
        message: Message,
    ) -> str:
        """
        Append a message to session history.

        Args:
            session_id: Session identifier
            message: Message to append

        Returns:
            Message ID of the appended message
        """
        pass

    @abstractmethod
    async def append_messages(
        self,
        session_id: str,
        messages: list[Message],
    ) -> list[str]:
        """
        Batch append messages to session history.

        Args:
            session_id: Session identifier
            messages: List of messages to append

        Returns:
            List of message IDs
        """
        pass

    @abstractmethod
    async def clear_history(self, session_id: str) -> bool:
        """
        Clear all history for a session.

        Args:
            session_id: Session identifier

        Returns:
            True if successful
        """
        pass

    @abstractmethod
    async def list_sessions(
        self,
        limit: int = 100,
        offset: int = 0,
    ) -> list[str]:
        """
        List all session IDs.

        Args:
            limit: Maximum number of sessions to return
            offset: Number of sessions to skip

        Returns:
            List of session IDs
        """
        pass

    async def update_message(
        self,
        session_id: str,
        message_id: str,
        content: Any,
    ) -> bool:
        """
        Update an existing message's content.

        Args:
            session_id: Session identifier
            message_id: Message ID to update
            content: New content

        Returns:
            True if successful
        """
        raise NotImplementedError("update_message is optional")

    async def delete_message(
        self,
        session_id: str,
        message_id: str,
    ) -> bool:
        """
        Delete a message.

        Args:
            session_id: Session identifier
            message_id: Message ID to delete

        Returns:
            True if successful
        """
        raise NotImplementedError("delete_message is optional")


class ToolResultStoreInterface(ABC):
    """
    Tool execution result storage interface (optional).

    Used for:
    - Caching tool execution results (avoid duplicate execution)
    - Supporting tool call checkpointing (tool.call_required scenario)
    """

    @abstractmethod
    async def save_tool_result(
        self,
        session_id: str,
        tool_call_id: str,
        result: Any,
        ttl: Optional[int] = None,
    ) -> bool:
        """
        Save tool execution result.

        Args:
            session_id: Session identifier
            tool_call_id: Tool call identifier
            result: Tool execution result
            ttl: Time-to-live in seconds

        Returns:
            True if successful
        """
        pass

    @abstractmethod
    async def get_tool_result(
        self,
        session_id: str,
        tool_call_id: str,
    ) -> Optional[Any]:
        """
        Get tool execution result.

        Args:
            session_id: Session identifier
            tool_call_id: Tool call identifier

        Returns:
            Tool result or None if not found
        """
        pass

    @abstractmethod
    async def get_pending_tool_calls(
        self,
        session_id: str,
    ) -> list[dict]:
        """
        Get pending tool calls (for tool.call_required scenario).

        Args:
            session_id: Session identifier

        Returns:
            List of pending tool call dicts
        """
        pass

    async def save_pending_tool_call(
        self,
        session_id: str,
        tool_call: dict,
    ) -> bool:
        """
        Save a pending tool call.

        Args:
            session_id: Session identifier
            tool_call: Tool call dict with id, name, input

        Returns:
            True if successful
        """
        raise NotImplementedError("save_pending_tool_call is optional")

    async def clear_pending_tool_calls(
        self,
        session_id: str,
    ) -> bool:
        """
        Clear pending tool calls for a session.

        Args:
            session_id: Session identifier

        Returns:
            True if successful
        """
        raise NotImplementedError("clear_pending_tool_calls is optional")


class StorageProvider(ABC):
    """
    Storage provider (factory) interface.

    Provides access to storage implementations.
    """

    @property
    @abstractmethod
    def history(self) -> HistoryStoreInterface:
        """Get history storage."""
        pass

    @property
    def tool_results(self) -> Optional[ToolResultStoreInterface]:
        """Get tool results storage (optional)."""
        return None

    @abstractmethod
    async def initialize(self) -> None:
        """Initialize storage (create tables, connect to DB, etc.)."""
        pass

    @abstractmethod
    async def close(self) -> None:
        """Close storage connections."""
        pass

    async def health_check(self) -> dict:
        """
        Check storage health.

        Returns:
            Dict with status and details
        """
        return {"status": "ok", "type": self.__class__.__name__}
