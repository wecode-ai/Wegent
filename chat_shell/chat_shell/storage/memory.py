"""
Memory-based storage implementation.

Provides in-memory storage for CLI and testing scenarios.
Data is lost when the process exits.
"""

import uuid
from datetime import datetime, timezone
from typing import Any, Optional

from chat_shell.storage.interfaces import (
    HistoryStoreInterface,
    Message,
    StorageProvider,
    ToolResultStoreInterface,
)


class MemoryHistoryStore(HistoryStoreInterface):
    """In-memory history storage implementation."""

    def __init__(self):
        self._histories: dict[str, list[Message]] = {}
        self._message_counter = 0

    async def get_history(
        self,
        session_id: str,
        limit: Optional[int] = None,
        before_message_id: Optional[str] = None,
    ) -> list[Message]:
        """Get chat history for a session."""
        messages = self._histories.get(session_id, [])

        # Filter by before_message_id if specified
        if before_message_id:
            filtered = []
            for msg in messages:
                if msg.id == before_message_id:
                    break
                filtered.append(msg)
            messages = filtered

        # Apply limit
        if limit:
            messages = messages[-limit:]

        return messages

    async def append_message(
        self,
        session_id: str,
        message: Message,
    ) -> str:
        """Append a message to session history."""
        if session_id not in self._histories:
            self._histories[session_id] = []

        self._message_counter += 1
        message.id = message.id or f"msg-{self._message_counter}"
        message.created_at = (
            message.created_at or datetime.now(timezone.utc).isoformat()
        )

        self._histories[session_id].append(message)
        return message.id

    async def append_messages(
        self,
        session_id: str,
        messages: list[Message],
    ) -> list[str]:
        """Batch append messages to session history."""
        message_ids = []
        for message in messages:
            msg_id = await self.append_message(session_id, message)
            message_ids.append(msg_id)
        return message_ids

    async def clear_history(self, session_id: str) -> bool:
        """Clear all history for a session."""
        if session_id in self._histories:
            del self._histories[session_id]
        return True

    async def list_sessions(
        self,
        limit: int = 100,
        offset: int = 0,
    ) -> list[str]:
        """List all session IDs."""
        sessions = list(self._histories.keys())
        return sessions[offset : offset + limit]

    async def update_message(
        self,
        session_id: str,
        message_id: str,
        content: Any,
    ) -> bool:
        """Update an existing message's content."""
        if session_id not in self._histories:
            return False

        for msg in self._histories[session_id]:
            if msg.id == message_id:
                msg.content = content
                return True
        return False

    async def delete_message(
        self,
        session_id: str,
        message_id: str,
    ) -> bool:
        """Delete a message."""
        if session_id not in self._histories:
            return False

        self._histories[session_id] = [
            msg for msg in self._histories[session_id] if msg.id != message_id
        ]
        return True


class MemoryToolResultStore(ToolResultStoreInterface):
    """In-memory tool result storage implementation."""

    def __init__(self):
        self._results: dict[str, dict[str, Any]] = (
            {}
        )  # session_id -> tool_call_id -> result
        self._pending_calls: dict[str, list[dict]] = (
            {}
        )  # session_id -> list of pending calls

    async def save_tool_result(
        self,
        session_id: str,
        tool_call_id: str,
        result: Any,
        ttl: Optional[int] = None,
    ) -> bool:
        """Save tool execution result."""
        if session_id not in self._results:
            self._results[session_id] = {}
        self._results[session_id][tool_call_id] = result
        return True

    async def get_tool_result(
        self,
        session_id: str,
        tool_call_id: str,
    ) -> Optional[Any]:
        """Get tool execution result."""
        if session_id not in self._results:
            return None
        return self._results[session_id].get(tool_call_id)

    async def get_pending_tool_calls(
        self,
        session_id: str,
    ) -> list[dict]:
        """Get pending tool calls."""
        return self._pending_calls.get(session_id, [])

    async def save_pending_tool_call(
        self,
        session_id: str,
        tool_call: dict,
    ) -> bool:
        """Save a pending tool call."""
        if session_id not in self._pending_calls:
            self._pending_calls[session_id] = []
        self._pending_calls[session_id].append(tool_call)
        return True

    async def clear_pending_tool_calls(
        self,
        session_id: str,
    ) -> bool:
        """Clear pending tool calls for a session."""
        if session_id in self._pending_calls:
            del self._pending_calls[session_id]
        return True


class MemoryStorageProvider(StorageProvider):
    """Memory-based storage provider."""

    def __init__(self):
        self._history = MemoryHistoryStore()
        self._tool_results = MemoryToolResultStore()
        self._initialized = False

    @property
    def history(self) -> HistoryStoreInterface:
        """Get history storage."""
        return self._history

    @property
    def tool_results(self) -> Optional[ToolResultStoreInterface]:
        """Get tool results storage."""
        return self._tool_results

    async def initialize(self) -> None:
        """Initialize storage."""
        self._initialized = True

    async def close(self) -> None:
        """Close storage."""
        self._initialized = False

    async def health_check(self) -> dict:
        """Check storage health."""
        return {
            "status": "ok" if self._initialized else "not_initialized",
            "type": "memory",
            "sessions": len(self._history._histories),
        }
