# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Global pending request registry for skills that require frontend interaction.

This module provides a centralized way to manage async requests that need
frontend rendering/processing before returning results to the AI.

The registry uses local asyncio for in-process request management.
For cross-worker communication in multi-worker deployments, the backend
should handle coordination.
"""
import asyncio
import logging
import os
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)

# Worker ID for identifying which worker owns a request
WORKER_ID = f"{os.getpid()}"


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
    Registry for managing pending skill requests.

    This provides a mechanism for skills to wait for async frontend interactions.
    Uses local asyncio.Future for in-process waiting.

    Key features:
    - Local futures are used for in-process async waiting
    - Automatic cleanup of expired requests
    - Thread-safe access via asyncio.Lock
    """

    def __init__(self):
        self._local_requests: Dict[str, PendingRequest] = {}
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

        # Create local request object
        request = PendingRequest(
            request_id=request_id,
            skill_name=skill_name,
            action=action,
            payload=payload,
            future=future,
            timeout_seconds=timeout_seconds,
        )

        async with self._lock:
            self._local_requests[request_id] = request

        logger.debug(
            f"[PendingRequestRegistry] Registered request {request_id} "
            f"for skill {skill_name} in worker {WORKER_ID}"
        )

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
            request = self._local_requests.pop(request_id, None)

        if not request:
            logger.warning(
                f"[PendingRequestRegistry] No pending request found for id: {request_id}"
            )
            return False

        if request.future.done():
            logger.warning(
                f"[PendingRequestRegistry] Request {request_id} already resolved"
            )
            return False

        # Check if result is already a complete response object
        if isinstance(result, dict) and "success" in result:
            response = result
        else:
            response = {
                "success": error is None,
                "result": result,
                "error": error,
            }

        request.future.set_result(response)
        logger.debug(f"[PendingRequestRegistry] Resolved request: {request_id}")
        return True

    async def get(self, request_id: str) -> Optional[PendingRequest]:
        """Get a pending request by ID without removing it."""
        async with self._lock:
            return self._local_requests.get(request_id)

    async def cleanup_expired(self) -> int:
        """Remove expired local requests and cancel their futures."""
        now = datetime.utcnow()
        expired_ids = []

        async with self._lock:
            for req_id, req in self._local_requests.items():
                elapsed = (now - req.created_at).total_seconds()
                if elapsed > req.timeout_seconds:
                    expired_ids.append(req_id)

            for req_id in expired_ids:
                req = self._local_requests.pop(req_id)
                if not req.future.done():
                    req.future.set_exception(
                        TimeoutError(
                            f"Request {req_id} timed out after {req.timeout_seconds}s"
                        )
                    )

        if expired_ids:
            logger.info(
                f"[PendingRequestRegistry] Cleaned up {len(expired_ids)} expired requests"
            )

        return len(expired_ids)


# Global singleton instance
_registry: Optional[PendingRequestRegistry] = None
_registry_lock = asyncio.Lock()


async def get_pending_request_registry() -> PendingRequestRegistry:
    """Get the global pending request registry."""
    global _registry

    if _registry is None:
        async with _registry_lock:
            if _registry is None:
                _registry = PendingRequestRegistry()

    return _registry


def get_pending_request_registry_sync() -> PendingRequestRegistry:
    """Get the global pending request registry synchronously."""
    global _registry

    if _registry is None:
        _registry = PendingRequestRegistry()

    return _registry


async def shutdown_pending_request_registry() -> None:
    """Shutdown the global pending request registry."""
    global _registry

    if _registry is not None:
        _registry = None
