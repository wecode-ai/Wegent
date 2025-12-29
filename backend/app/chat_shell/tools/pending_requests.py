# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Global pending request registry for skills that require frontend interaction.

This module provides a centralized way to manage async requests that need
frontend rendering/processing before returning results to the AI.

The registry uses Redis for cross-process communication, allowing requests
to be resolved by any worker in a multi-worker deployment (e.g., gunicorn).

Architecture:
- Requests are registered with a unique request_id
- Request metadata is stored in Redis with TTL
- Local asyncio.Future is used for in-process waiting
- Redis Pub/Sub is used to notify the correct worker when a response arrives
"""
import asyncio
import json
import logging
import os
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Callable, Dict, Optional

import orjson
from redis.asyncio import Redis

from app.core.config import settings

logger = logging.getLogger(__name__)

# Redis key prefixes
PENDING_REQUEST_PREFIX = "skill:pending:"
PENDING_RESPONSE_PREFIX = "skill:response:"
PUBSUB_CHANNEL = "skill:responses"

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
    Redis-backed registry for managing pending skill requests.

    This provides a cross-process mechanism that any skill can use for
    async frontend interactions. Uses Redis for state storage and Pub/Sub
    for cross-worker notification.

    Key features:
    - Requests are stored in Redis with TTL for automatic cleanup
    - Local futures are used for in-process async waiting
    - Pub/Sub notifies the correct worker when a response arrives
    - Supports multi-worker deployments (gunicorn, uvicorn workers)
    """

    def __init__(self):
        self._local_requests: Dict[str, PendingRequest] = {}
        self._lock = asyncio.Lock()
        self._pubsub_task: Optional[asyncio.Task] = None
        self._redis_url = settings.REDIS_URL
        self._shutdown = False

    async def _get_redis_client(self, for_pubsub: bool = False) -> Redis:
        """Get a new Redis client connection.

        Args:
            for_pubsub: If True, use longer timeout for Pub/Sub connections
                       which need to wait for messages.
        """
        # For Pub/Sub, we need a longer timeout or no timeout
        # to avoid "Timeout reading" errors when waiting for messages
        socket_timeout = None if for_pubsub else 5.0

        return Redis.from_url(
            self._redis_url,
            encoding="utf-8",
            decode_responses=False,
            socket_timeout=socket_timeout,
            socket_connect_timeout=5.0,
        )

    async def start_pubsub_listener(self) -> None:
        """Start the Pub/Sub listener for cross-worker notifications.

        This should be called once when the application starts.
        """
        if self._pubsub_task is not None:
            return

        self._pubsub_task = asyncio.create_task(self._pubsub_listener())
        logger.info(
            f"[PendingRequestRegistry] Started Pub/Sub listener for worker {WORKER_ID}"
        )

    async def stop_pubsub_listener(self) -> None:
        """Stop the Pub/Sub listener.

        This should be called when the application shuts down.
        """
        self._shutdown = True
        if self._pubsub_task is not None:
            self._pubsub_task.cancel()
            try:
                await self._pubsub_task
            except asyncio.CancelledError:
                pass
            self._pubsub_task = None
            logger.info(
                f"[PendingRequestRegistry] Stopped Pub/Sub listener for worker {WORKER_ID}"
            )

    async def _pubsub_listener(self) -> None:
        """Listen for response notifications via Redis Pub/Sub."""
        while not self._shutdown:
            try:
                # Use for_pubsub=True to get a client with no socket timeout
                # This prevents "Timeout reading" errors when waiting for messages
                client = await self._get_redis_client(for_pubsub=True)
                pubsub = client.pubsub()
                await pubsub.subscribe(PUBSUB_CHANNEL)

                logger.debug(
                    f"[PendingRequestRegistry] Subscribed to channel {PUBSUB_CHANNEL}"
                )

                async for message in pubsub.listen():
                    if self._shutdown:
                        break

                    if message["type"] != "message":
                        continue

                    try:
                        data = orjson.loads(message["data"])
                        request_id = data.get("request_id")
                        target_worker = data.get("worker_id")

                        # Only process if this message is for our worker
                        if target_worker != WORKER_ID:
                            continue

                        logger.debug(
                            f"[PendingRequestRegistry] Received response notification "
                            f"for request {request_id}"
                        )

                        # Resolve the local future
                        await self._resolve_local(
                            request_id=request_id,
                            result=data.get("result"),
                            error=data.get("error"),
                        )
                    except Exception as e:
                        logger.error(
                            f"[PendingRequestRegistry] Error processing Pub/Sub message: {e}"
                        )

                await pubsub.unsubscribe(PUBSUB_CHANNEL)
                await client.aclose()

            except asyncio.CancelledError:
                break
            except Exception as e:
                if not self._shutdown:
                    logger.error(
                        f"[PendingRequestRegistry] Pub/Sub listener error: {e}, "
                        f"reconnecting in 1s..."
                    )
                    await asyncio.sleep(1)

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

        The request metadata is stored in Redis for cross-worker access,
        and a local future is created for in-process waiting.

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

        # Store request metadata in Redis
        try:
            client = await self._get_redis_client()
            try:
                redis_key = f"{PENDING_REQUEST_PREFIX}{request_id}"
                redis_data = orjson.dumps(
                    {
                        "request_id": request_id,
                        "skill_name": skill_name,
                        "action": action,
                        "worker_id": WORKER_ID,
                        "created_at": datetime.utcnow().isoformat(),
                        "timeout_seconds": timeout_seconds,
                    }
                )
                # Set with TTL slightly longer than timeout to allow for processing
                await client.set(redis_key, redis_data, ex=int(timeout_seconds) + 10)
                logger.debug(
                    f"[PendingRequestRegistry] Registered request {request_id} "
                    f"for skill {skill_name} in worker {WORKER_ID}"
                )
            finally:
                await client.aclose()
        except Exception as e:
            logger.error(
                f"[PendingRequestRegistry] Failed to store request in Redis: {e}"
            )
            # Continue anyway - local future will still work for same-worker responses

        return future

    async def resolve(
        self,
        request_id: str,
        result: Any,
        error: Optional[str] = None,
    ) -> bool:
        """
        Resolve a pending request with result or error.

        This method looks up the request in Redis to find which worker
        owns it, then publishes a notification via Pub/Sub.

        Args:
            request_id: The request to resolve
            result: Success result data
            error: Error message if failed

        Returns:
            True if request was found and resolved, False otherwise
        """
        try:
            client = await self._get_redis_client()
            try:
                # Get request metadata from Redis
                redis_key = f"{PENDING_REQUEST_PREFIX}{request_id}"
                data = await client.get(redis_key)

                if not data:
                    logger.warning(
                        f"[PendingRequestRegistry] No pending request found "
                        f"in Redis for id: {request_id}"
                    )
                    # Try local resolution as fallback
                    return await self._resolve_local(request_id, result, error)

                request_data = orjson.loads(data)
                target_worker = request_data.get("worker_id")

                # Delete the request from Redis
                await client.delete(redis_key)

                # If the request is owned by this worker, resolve locally
                if target_worker == WORKER_ID:
                    return await self._resolve_local(request_id, result, error)

                # Otherwise, publish notification to the owning worker
                notification = orjson.dumps(
                    {
                        "request_id": request_id,
                        "worker_id": target_worker,
                        "result": result,
                        "error": error,
                    }
                )
                await client.publish(PUBSUB_CHANNEL, notification)
                logger.debug(
                    f"[PendingRequestRegistry] Published response notification "
                    f"for request {request_id} to worker {target_worker}"
                )
                return True

            finally:
                await client.aclose()

        except Exception as e:
            logger.error(
                f"[PendingRequestRegistry] Error resolving request {request_id}: {e}"
            )
            # Try local resolution as fallback
            return await self._resolve_local(request_id, result, error)

    async def _resolve_local(
        self,
        request_id: str,
        result: Any,
        error: Optional[str] = None,
    ) -> bool:
        """Resolve a request using the local future.

        Args:
            request_id: The request to resolve
            result: The result data. If this is a dict with 'success', 'result', 'error' keys,
                   it will be used directly as the response. Otherwise, a response object
                   will be built using the result and error parameters.
            error: Error message if failed (used when result is not a complete response)

        Returns:
            True if request was found and resolved, False otherwise
        """
        async with self._lock:
            request = self._local_requests.pop(request_id, None)

        if not request:
            logger.warning(
                f"[PendingRequestRegistry] No local request found for id: {request_id}"
            )
            return False

        if request.future.done():
            logger.warning(
                f"[PendingRequestRegistry] Request {request_id} already resolved"
            )
            return False

        # Check if result is already a complete response object (from on_skill_response)
        # This happens when the caller has already built the response with success/result/error
        if isinstance(result, dict) and "success" in result:
            # Use the result directly as the response
            response = result
            logger.debug(
                f"[PendingRequestRegistry] Using complete response object for {request_id}, "
                f"success={response.get('success')}"
            )
        else:
            # Build response object for legacy callers
            response = {
                "success": error is None,
                "result": result,
                "error": error,
            }
            logger.debug(
                f"[PendingRequestRegistry] Built response from result/error: "
                f"success={error is None}"
            )

        request.future.set_result(response)

        logger.debug(f"[PendingRequestRegistry] Resolved local request: {request_id}")
        return True

    async def get(self, request_id: str) -> Optional[PendingRequest]:
        """Get a pending request by ID without removing it."""
        async with self._lock:
            return self._local_requests.get(request_id)

    async def cleanup_expired(self) -> int:
        """Remove expired local requests and cancel their futures.

        Note: Redis handles expiration via TTL automatically.
        This method only cleans up local futures.
        """
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
    """Get the global pending request registry.

    This function ensures the registry is initialized and the Pub/Sub
    listener is started.
    """
    global _registry

    if _registry is None:
        async with _registry_lock:
            if _registry is None:
                _registry = PendingRequestRegistry()
                await _registry.start_pubsub_listener()

    return _registry


def get_pending_request_registry_sync() -> PendingRequestRegistry:
    """Get the global pending request registry synchronously.

    Note: This does not start the Pub/Sub listener. Use the async version
    for full functionality.
    """
    global _registry

    if _registry is None:
        _registry = PendingRequestRegistry()

    return _registry


async def shutdown_pending_request_registry() -> None:
    """Shutdown the global pending request registry.

    This should be called when the application shuts down.
    """
    global _registry

    if _registry is not None:
        await _registry.stop_pubsub_listener()
        _registry = None
