# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Event emitter module for LangGraph Chat Service.

This module provides WebSocket event emission capabilities by
re-exporting the existing ws_emitter from the chat service.

Usage:
    from .events import event_emitter
    await event_emitter.emit_chat_start(task_id, subtask_id)
"""


class _EventEmitterProxy:
    """Lazy proxy to WebSocket emitter to avoid circular imports."""

    _emitter = None

    def _get_emitter(self):
        """Lazily get the WebSocket emitter instance."""
        if self._emitter is not None:
            return self._emitter

        from app.services.chat.ws_emitter import get_ws_emitter

        emitter = get_ws_emitter()
        if emitter is not None:
            self._emitter = emitter
        return emitter

    def __getattr__(self, name: str):
        emitter = self._get_emitter()
        if emitter is None:
            # Return a no-op async function if emitter not available
            async def noop(*args, **kwargs):
                pass

            return noop
        return getattr(emitter, name)


# Global event emitter instance
event_emitter = _EventEmitterProxy()
