# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Abstract base class for knowledge base tools.

This module defines the interface for knowledge base tools that need to
persist their results to the context database. All KB tools (RAG search,
kb_head, kb_ls, etc.) should inherit from this class to ensure consistent
persistence behavior.
"""

from abc import ABC, abstractmethod
from typing import Any, Dict, List, Optional

from sqlalchemy.orm import Session


class KnowledgeBaseToolABC(ABC):
    """Abstract base class defining the interface for knowledge base tools.

    All knowledge base tools (RAG search, kb_head, kb_ls, etc.) should inherit
    from this class to ensure consistent persistence behavior.

    This ABC enforces that all KB tools implement a `_persist_result` method
    for saving tool results to the SubtaskContext database, enabling cross-turn
    history restoration.

    Attributes that subclasses must provide:
        user_subtask_id: Optional subtask ID for persistence tracking.
            When set, enables persistence of tool results.
        knowledge_base_ids: List of allowed knowledge base IDs.
            Used for access control and persistence routing.
        user_id: User ID for context creation when auto-creating records.
        db_session: Optional database session for package mode.
            In HTTP mode, this may be None.
    """

    # Declare expected attributes (subclasses must set these)
    user_subtask_id: Optional[int]
    knowledge_base_ids: List[int]
    user_id: int
    db_session: Optional[Session]

    @abstractmethod
    async def _persist_result(
        self,
        kb_id: int,
        result_data: Dict[str, Any],
    ) -> None:
        """Persist tool result to context database.

        Subclasses must implement this method to persist their specific
        result data to the SubtaskContext record.

        This method should:
        1. Handle both package mode (direct DB) and HTTP mode (via API)
        2. Support auto-creation of context records when they don't exist
        3. Log warnings but not fail if persistence fails
        4. Route results to the correct KB's context record

        Args:
            kb_id: Knowledge base ID for this result. Used to find or create
                the appropriate SubtaskContext record.
            result_data: Tool-specific result data to persist. Structure varies
                by tool type:
                - RAG: {"extracted_text", "sources", "injection_mode", "query", "chunks_count"}
                - kb_head: {"document_ids", "offset", "limit"}
        """
        pass

    def _should_persist(self) -> bool:
        """Check if persistence should be attempted.

        Persistence requires both user_subtask_id (to identify where to store)
        and knowledge_base_ids (to route results correctly).

        Returns:
            True if user_subtask_id and knowledge_base_ids are available,
            False otherwise.
        """
        return bool(self.user_subtask_id and self.knowledge_base_ids)
