# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Storage proxy for LangGraph Chat Service.

Provides a unified interface to db_handler and session_manager.
"""

from typing import Any


class StorageProxy:
    """Lazy proxy to storage handlers to avoid circular imports.

    Delegates to db_handler and session_manager from the chat service.
    Uses __getattr__ for dynamic method forwarding.
    """

    _db_handler = None
    _session_manager = None

    @classmethod
    def _ensure_handlers(cls):
        """Lazy load handlers to avoid circular imports."""
        if cls._db_handler is None:
            from .db import db_handler
            from .session import session_manager

            cls._db_handler = db_handler
            cls._session_manager = session_manager

    def __getattr__(self, name: str) -> Any:
        """Forward attribute access to underlying handlers."""
        self._ensure_handlers()
        # Try db_handler first, then session_manager
        if hasattr(self._db_handler, name):
            return getattr(self._db_handler, name)
        if hasattr(self._session_manager, name):
            return getattr(self._session_manager, name)
        raise AttributeError(f"'{type(self).__name__}' has no attribute '{name}'")
