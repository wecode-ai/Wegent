# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Global pending request registry for skills that require frontend interaction.

This module provides a centralized way to manage async requests that need
frontend rendering/processing before returning results to the AI.
"""
import asyncio
import logging
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)


@dataclass
class PendingRequest:
    """Represents a pending skill request waiting for frontend response."""

    request_id: str
    skill_name: str
    action: str
    payload: Dict[str, Any]
    future: asyncio.Future
    created_at: datetime = field(default_factory=datetime.utcnow)
    timeout_seconds: float = 30.0


class PendingRequestRegistry:
    """
    Thread-safe registry for managing pending skill requests.

    This provides a generic mechanism that any skill can use for
    async frontend interactions.
    """

    def __init__(self):
        self._requests: Dict[str, PendingRequest] = {}
        self._lock = asyncio.Lock()

    async def register(
        self,
        request_id: str,
        skill_name: str,
        action: str,
        payload: Dict[str, Any],
        timeout_seconds: float = 30.0,
    ) -> asyncio.Future:
        """
        Register a new pending request and return a future to await.

        Args:
            request_id: Unique identifier for this request
            skill_name: Name of the skill making the request
            action: Action type (e.g., "render", "validate")
            payload: Data to send to frontend
            timeout_seconds: How long to wait for response

        Returns:
            Future that will be resolved when frontend responds
        """
        loop = asyncio.get_event_loop()
        future = loop.create_future()

        async with self._lock:
            self._requests[request_id] = PendingRequest(
                request_id=request_id,
                skill_name=skill_name,
                action=action,
                payload=payload,
                future=future,
                timeout_seconds=timeout_seconds,
            )

        logger.debug(f"Registered pending request: {request_id} for skill {skill_name}")
        return future

    async def resolve(
        self,
        request_id: str,
        result: Any,
        error: Optional[str] = None,
    ) -> bool:
        """
        Resolve a pending request with result or error.

        Args:
            request_id: The request to resolve
            result: Success result data
            error: Error message if failed

        Returns:
            True if request was found and resolved, False otherwise
        """
        async with self._lock:
            request = self._requests.pop(request_id, None)

        if not request:
            logger.warning(f"No pending request found for id: {request_id}")
            return False

        if request.future.done():
            logger.warning(f"Request {request_id} already resolved")
            return False

        if error:
            request.future.set_exception(Exception(error))
        else:
            request.future.set_result(result)

        logger.debug(f"Resolved pending request: {request_id}")
        return True

    async def get(self, request_id: str) -> Optional[PendingRequest]:
        """Get a pending request by ID without removing it."""
        async with self._lock:
            return self._requests.get(request_id)

    async def cleanup_expired(self) -> int:
        """Remove expired requests and cancel their futures."""
        now = datetime.utcnow()
        expired_ids = []

        async with self._lock:
            for req_id, req in self._requests.items():
                elapsed = (now - req.created_at).total_seconds()
                if elapsed > req.timeout_seconds:
                    expired_ids.append(req_id)

            for req_id in expired_ids:
                req = self._requests.pop(req_id)
                if not req.future.done():
                    req.future.set_exception(
                        TimeoutError(
                            f"Request {req_id} timed out after {req.timeout_seconds}s"
                        )
                    )

        if expired_ids:
            logger.info(f"Cleaned up {len(expired_ids)} expired requests")

        return len(expired_ids)


# Global singleton instance
_registry = PendingRequestRegistry()


def get_pending_request_registry() -> PendingRequestRegistry:
    """Get the global pending request registry."""
    return _registry
