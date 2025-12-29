# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Chat Shell direct chat service module.

This module provides direct LLM API calling capabilities for Chat Shell type,
bypassing the Docker Executor container for lightweight chat scenarios.

Architecture (Refactored):
- access/: Access control and authentication
- config/: Chat configuration
- operations/: Chat operations (cancel, retry, resume)
- preprocessing/: Attachment preprocessing
- rag/: RAG processing
- storage/: Database and session management
- streaming/: WebSocket streaming handlers
- trigger/: AI response triggering
- ws_emitter.py: WebSocket event emitter
"""

# Storage imports (from new modular structure)
from app.services.chat.storage import db_handler, session_manager, storage_handler

__all__ = [
    # Storage
    "db_handler",
    "session_manager",
    "storage_handler",
]
