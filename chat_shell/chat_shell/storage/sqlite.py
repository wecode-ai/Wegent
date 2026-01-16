"""
SQLite-based storage implementation.

Provides persistent local storage for CLI scenarios.
Data is stored in a SQLite database file.
"""

import json
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

import aiosqlite

from chat_shell.storage.interfaces import (
    HistoryStoreInterface,
    Message,
    StorageProvider,
    ToolResultStoreInterface,
)


class SQLiteHistoryStore(HistoryStoreInterface):
    """SQLite-based history storage implementation."""

    def __init__(self, db_path: str):
        self.db_path = Path(db_path).expanduser().resolve()
        self.db_path.parent.mkdir(parents=True, exist_ok=True)

    async def initialize(self) -> None:
        """Create tables if they don't exist."""
        async with aiosqlite.connect(self.db_path) as db:
            await db.execute(
                """
                CREATE TABLE IF NOT EXISTS messages (
                    id TEXT PRIMARY KEY,
                    session_id TEXT NOT NULL,
                    role TEXT NOT NULL,
                    content TEXT NOT NULL,
                    name TEXT,
                    tool_call_id TEXT,
                    tool_calls TEXT,
                    metadata TEXT,
                    created_at TEXT NOT NULL,
                    UNIQUE(session_id, id)
                )
            """
            )
            await db.execute(
                """
                CREATE INDEX IF NOT EXISTS idx_messages_session_id
                ON messages(session_id)
            """
            )
            await db.execute(
                """
                CREATE INDEX IF NOT EXISTS idx_messages_created_at
                ON messages(session_id, created_at)
            """
            )
            await db.commit()

    async def get_history(
        self,
        session_id: str,
        limit: Optional[int] = None,
        before_message_id: Optional[str] = None,
    ) -> list[Message]:
        """Get chat history for a session."""
        async with aiosqlite.connect(self.db_path) as db:
            # Build query
            if before_message_id:
                # Get created_at of the reference message
                cursor = await db.execute(
                    "SELECT created_at FROM messages WHERE id = ? AND session_id = ?",
                    (before_message_id, session_id),
                )
                row = await cursor.fetchone()
                if row:
                    before_created_at = row[0]
                    query = """
                        SELECT id, role, content, name, tool_call_id, tool_calls, metadata, created_at
                        FROM messages
                        WHERE session_id = ? AND created_at < ?
                        ORDER BY created_at ASC
                    """
                    params = [session_id, before_created_at]
                else:
                    return []
            else:
                query = """
                    SELECT id, role, content, name, tool_call_id, tool_calls, metadata, created_at
                    FROM messages
                    WHERE session_id = ?
                    ORDER BY created_at ASC
                """
                params = [session_id]

            if limit:
                # For limit with ORDER BY ASC, we need a subquery to get last N
                query = f"""
                    SELECT * FROM (
                        SELECT id, role, content, name, tool_call_id, tool_calls, metadata, created_at
                        FROM messages
                        WHERE session_id = ?
                        {"AND created_at < ?" if before_message_id else ""}
                        ORDER BY created_at DESC
                        LIMIT ?
                    ) ORDER BY created_at ASC
                """
                params.append(limit)

            cursor = await db.execute(query, params)
            rows = await cursor.fetchall()

            messages = []
            for row in rows:
                content = row[2]
                try:
                    content = json.loads(content)
                except (json.JSONDecodeError, TypeError):
                    pass

                tool_calls = row[5]
                if tool_calls:
                    try:
                        tool_calls = json.loads(tool_calls)
                    except (json.JSONDecodeError, TypeError):
                        tool_calls = None

                metadata = row[6]
                if metadata:
                    try:
                        metadata = json.loads(metadata)
                    except (json.JSONDecodeError, TypeError):
                        metadata = {}
                else:
                    metadata = {}

                messages.append(
                    Message(
                        id=row[0],
                        role=row[1],
                        content=content,
                        name=row[3],
                        tool_call_id=row[4],
                        tool_calls=tool_calls,
                        metadata=metadata,
                        created_at=row[7],
                    )
                )

            return messages

    async def append_message(
        self,
        session_id: str,
        message: Message,
    ) -> str:
        """Append a message to session history."""
        message_id = message.id or str(uuid.uuid4())
        created_at = message.created_at or datetime.now(timezone.utc).isoformat()

        # Serialize content
        content = message.content
        if not isinstance(content, str):
            content = json.dumps(content, ensure_ascii=False)

        # Serialize tool_calls
        tool_calls = None
        if message.tool_calls:
            tool_calls = json.dumps(message.tool_calls, ensure_ascii=False)

        # Serialize metadata
        metadata = None
        if message.metadata:
            metadata = json.dumps(message.metadata, ensure_ascii=False)

        async with aiosqlite.connect(self.db_path) as db:
            await db.execute(
                """
                INSERT INTO messages
                (id, session_id, role, content, name, tool_call_id, tool_calls, metadata, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
                (
                    message_id,
                    session_id,
                    message.role,
                    content,
                    message.name,
                    message.tool_call_id,
                    tool_calls,
                    metadata,
                    created_at,
                ),
            )
            await db.commit()

        return message_id

    async def append_messages(
        self,
        session_id: str,
        messages: list[Message],
    ) -> list[str]:
        """Batch append messages to session history."""
        message_ids = []
        async with aiosqlite.connect(self.db_path) as db:
            for message in messages:
                message_id = message.id or str(uuid.uuid4())
                created_at = (
                    message.created_at or datetime.now(timezone.utc).isoformat()
                )

                content = message.content
                if not isinstance(content, str):
                    content = json.dumps(content, ensure_ascii=False)

                tool_calls = None
                if message.tool_calls:
                    tool_calls = json.dumps(message.tool_calls, ensure_ascii=False)

                metadata = None
                if message.metadata:
                    metadata = json.dumps(message.metadata, ensure_ascii=False)

                await db.execute(
                    """
                    INSERT INTO messages
                    (id, session_id, role, content, name, tool_call_id, tool_calls, metadata, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                    (
                        message_id,
                        session_id,
                        message.role,
                        content,
                        message.name,
                        message.tool_call_id,
                        tool_calls,
                        metadata,
                        created_at,
                    ),
                )
                message_ids.append(message_id)

            await db.commit()
        return message_ids

    async def clear_history(self, session_id: str) -> bool:
        """Clear all history for a session."""
        async with aiosqlite.connect(self.db_path) as db:
            await db.execute("DELETE FROM messages WHERE session_id = ?", (session_id,))
            await db.commit()
        return True

    async def list_sessions(
        self,
        limit: int = 100,
        offset: int = 0,
    ) -> list[str]:
        """List all session IDs."""
        async with aiosqlite.connect(self.db_path) as db:
            cursor = await db.execute(
                """
                SELECT DISTINCT session_id
                FROM messages
                GROUP BY session_id
                ORDER BY MAX(created_at) DESC
                LIMIT ? OFFSET ?
            """,
                (limit, offset),
            )
            rows = await cursor.fetchall()
            return [row[0] for row in rows]

    async def update_message(
        self,
        session_id: str,
        message_id: str,
        content: Any,
    ) -> bool:
        """Update an existing message's content."""
        content_str = content
        if not isinstance(content_str, str):
            content_str = json.dumps(content_str, ensure_ascii=False)

        async with aiosqlite.connect(self.db_path) as db:
            cursor = await db.execute(
                """
                UPDATE messages
                SET content = ?
                WHERE id = ? AND session_id = ?
            """,
                (content_str, message_id, session_id),
            )
            await db.commit()
            return cursor.rowcount > 0

    async def delete_message(
        self,
        session_id: str,
        message_id: str,
    ) -> bool:
        """Delete a message."""
        async with aiosqlite.connect(self.db_path) as db:
            cursor = await db.execute(
                "DELETE FROM messages WHERE id = ? AND session_id = ?",
                (message_id, session_id),
            )
            await db.commit()
            return cursor.rowcount > 0


class SQLiteToolResultStore(ToolResultStoreInterface):
    """SQLite-based tool result storage implementation."""

    def __init__(self, db_path: str):
        self.db_path = Path(db_path).expanduser().resolve()

    async def _get_connection(self) -> aiosqlite.Connection:
        """Get database connection."""
        return await aiosqlite.connect(self.db_path)

    async def initialize(self) -> None:
        """Create tables if they don't exist."""
        async with aiosqlite.connect(self.db_path) as db:
            await db.execute(
                """
                CREATE TABLE IF NOT EXISTS tool_results (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    session_id TEXT NOT NULL,
                    tool_call_id TEXT NOT NULL,
                    result TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    expires_at TEXT,
                    UNIQUE(session_id, tool_call_id)
                )
            """
            )
            await db.execute(
                """
                CREATE TABLE IF NOT EXISTS pending_tool_calls (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    session_id TEXT NOT NULL,
                    tool_call_id TEXT NOT NULL,
                    tool_name TEXT NOT NULL,
                    tool_input TEXT NOT NULL,
                    created_at TEXT NOT NULL
                )
            """
            )
            await db.execute(
                """
                CREATE INDEX IF NOT EXISTS idx_tool_results_session
                ON tool_results(session_id)
            """
            )
            await db.execute(
                """
                CREATE INDEX IF NOT EXISTS idx_pending_calls_session
                ON pending_tool_calls(session_id)
            """
            )
            await db.commit()

    async def save_tool_result(
        self,
        session_id: str,
        tool_call_id: str,
        result: Any,
        ttl: Optional[int] = None,
    ) -> bool:
        """Save tool execution result."""
        result_str = json.dumps(result, ensure_ascii=False)
        created_at = datetime.now(timezone.utc).isoformat()
        expires_at = None
        if ttl:
            from datetime import timedelta

            expires_at = (
                datetime.now(timezone.utc) + timedelta(seconds=ttl)
            ).isoformat()

        async with aiosqlite.connect(self.db_path) as db:
            await db.execute(
                """
                INSERT OR REPLACE INTO tool_results
                (session_id, tool_call_id, result, created_at, expires_at)
                VALUES (?, ?, ?, ?, ?)
            """,
                (session_id, tool_call_id, result_str, created_at, expires_at),
            )
            await db.commit()
        return True

    async def get_tool_result(
        self,
        session_id: str,
        tool_call_id: str,
    ) -> Optional[Any]:
        """Get tool execution result."""
        async with aiosqlite.connect(self.db_path) as db:
            cursor = await db.execute(
                """
                SELECT result, expires_at FROM tool_results
                WHERE session_id = ? AND tool_call_id = ?
            """,
                (session_id, tool_call_id),
            )
            row = await cursor.fetchone()
            if not row:
                return None

            # Check expiration
            if row[1]:
                expires_at = datetime.fromisoformat(row[1])
                if datetime.now(timezone.utc) > expires_at:
                    await db.execute(
                        "DELETE FROM tool_results WHERE session_id = ? AND tool_call_id = ?",
                        (session_id, tool_call_id),
                    )
                    await db.commit()
                    return None

            return json.loads(row[0])

    async def get_pending_tool_calls(
        self,
        session_id: str,
    ) -> list[dict]:
        """Get pending tool calls."""
        async with aiosqlite.connect(self.db_path) as db:
            cursor = await db.execute(
                """
                SELECT tool_call_id, tool_name, tool_input, created_at
                FROM pending_tool_calls
                WHERE session_id = ?
                ORDER BY created_at ASC
            """,
                (session_id,),
            )
            rows = await cursor.fetchall()
            return [
                {
                    "id": row[0],
                    "name": row[1],
                    "input": json.loads(row[2]),
                    "created_at": row[3],
                }
                for row in rows
            ]

    async def save_pending_tool_call(
        self,
        session_id: str,
        tool_call: dict,
    ) -> bool:
        """Save a pending tool call."""
        created_at = datetime.now(timezone.utc).isoformat()
        tool_input = json.dumps(tool_call.get("input", {}), ensure_ascii=False)

        async with aiosqlite.connect(self.db_path) as db:
            await db.execute(
                """
                INSERT INTO pending_tool_calls
                (session_id, tool_call_id, tool_name, tool_input, created_at)
                VALUES (?, ?, ?, ?, ?)
            """,
                (
                    session_id,
                    tool_call.get("id", str(uuid.uuid4())),
                    tool_call.get("name", ""),
                    tool_input,
                    created_at,
                ),
            )
            await db.commit()
        return True

    async def clear_pending_tool_calls(
        self,
        session_id: str,
    ) -> bool:
        """Clear pending tool calls for a session."""
        async with aiosqlite.connect(self.db_path) as db:
            await db.execute(
                "DELETE FROM pending_tool_calls WHERE session_id = ?",
                (session_id,),
            )
            await db.commit()
        return True


class SQLiteStorageProvider(StorageProvider):
    """SQLite-based storage provider."""

    def __init__(self, db_path: str = "~/.chat_shell/history.db"):
        self.db_path = str(Path(db_path).expanduser().resolve())
        self._history = SQLiteHistoryStore(self.db_path)
        self._tool_results = SQLiteToolResultStore(self.db_path)
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
        """Initialize storage (create tables)."""
        await self._history.initialize()
        await self._tool_results.initialize()
        self._initialized = True

    async def close(self) -> None:
        """Close storage."""
        self._initialized = False

    async def health_check(self) -> dict:
        """Check storage health."""
        try:
            async with aiosqlite.connect(self.db_path) as db:
                cursor = await db.execute("SELECT 1")
                await cursor.fetchone()
            return {
                "status": "ok",
                "type": "sqlite",
                "db_path": self.db_path,
            }
        except Exception as e:
            return {
                "status": "error",
                "type": "sqlite",
                "error": str(e),
            }
