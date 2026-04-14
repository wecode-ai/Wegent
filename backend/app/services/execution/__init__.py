# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Execution module for task dispatch.

This module provides unified task dispatch functionality including:
- ExecutionRouter: Routes tasks to execution targets
- ExecutionDispatcher: Dispatches tasks via SSE/WebSocket/HTTP
- ResultEmitter: Unified interface for emitting execution events
- TaskRequestBuilder: Builds ExecutionRequest from database models
- schedule_dispatch: Helper for dispatching tasks from sync context
- ExecutorRecoveryService: Recovers executor Pods after deletion
"""

import json

from shared.models import ExecutionRequest

from .dispatcher import ExecutionDispatcher, execution_dispatcher
from .emitters import (
    BaseResultEmitter,
    BatchCallbackEmitter,
    CallbackResultEmitter,
    CompositeResultEmitter,
    DirectSSEEmitter,
    EmitterType,
    QueueBasedEmitter,
    ResultEmitter,
    ResultEmitterFactory,
    SSEResultEmitter,
    StreamableEmitter,
    WebSocketResultEmitter,
)
from .recovery_service import ExecutorRecoveryService, recovery_service
from .request_builder import TaskRequestBuilder
from .router import CommunicationMode, ExecutionRouter, ExecutionTarget
from .schedule_helper import schedule_dispatch


def get_executor_runtime_client():
    """Get the executor runtime client for runtime preparation APIs."""
    return _ExecutorRuntimeClient()


class _ExecutorRuntimeClient:
    """Thin client for calling executor_manager runtime APIs."""

    @staticmethod
    def _format_http_error(error: Exception) -> str:
        """Build a stable error string from executor-manager HTTP failures."""
        try:
            import httpx

            if isinstance(error, httpx.HTTPStatusError):
                response = error.response
                detail = ""
                try:
                    payload = response.json()
                except (ValueError, json.JSONDecodeError):
                    payload = None

                if isinstance(payload, dict):
                    detail = (
                        payload.get("detail")
                        or payload.get("error_msg")
                        or payload.get("message")
                        or ""
                    )

                if not detail:
                    detail = response.text or str(error)

                request_id = response.headers.get("X-Request-ID")
                error_message = (
                    f"executor-manager prepare failed: status={response.status_code} "
                    f"detail={detail}"
                )
                if request_id:
                    error_message = f"{error_message} request_id={request_id}"
                return error_message
        except Exception:
            pass

        return str(error)

    async def create_sandbox(
        self,
        shell_type: str,
        user_id: int,
        user_name: str,
        timeout: int = None,
        workspace_ref: str = None,
        bot_config: dict = None,
        metadata: dict = None,
    ):
        """Create a sandbox via executor_manager API."""
        import httpx

        from app.core.config import settings

        base_url = settings.EXECUTOR_MANAGER_URL.rstrip("/")
        url = f"{base_url}/executor-manager/sandboxes"

        payload = {
            "shell_type": shell_type,
            "user_id": user_id,
            "user_name": user_name,
            "metadata": metadata or {},
        }

        if timeout:
            payload["timeout"] = timeout
        if workspace_ref:
            payload["workspace_ref"] = workspace_ref
        if bot_config:
            payload["bot_config"] = bot_config

        try:
            async with httpx.AsyncClient(timeout=180.0) as client:
                response = await client.post(
                    url,
                    json=payload,
                    headers={"Content-Type": "application/json"},
                )
                response.raise_for_status()
                data = response.json()

                # Create a simple sandbox object
                class SimpleSandbox:
                    def __init__(self, data):
                        self.sandbox_id = data.get("sandbox_id")
                        self.container_name = data.get("container_name")
                        self.base_url = data.get("base_url")
                        self.executor_namespace = data.get("executor_namespace")
                        self.metadata = data.get("metadata", {})

                return SimpleSandbox(data), None
        except Exception as e:
            return None, str(e)

    async def prepare_executor(self, request: ExecutionRequest):
        """Prepare a normal executor runtime without dispatching the task."""
        import httpx

        from app.core.config import settings

        base_url = settings.EXECUTOR_MANAGER_URL.rstrip("/")
        url = f"{base_url}/executor-manager/executors/prepare"

        try:
            async with httpx.AsyncClient(timeout=180.0) as client:
                response = await client.post(
                    url,
                    json=request.to_dict(),
                    headers={"Content-Type": "application/json"},
                )
                response.raise_for_status()
                data = response.json()

                class SimpleSandbox:
                    def __init__(self, data):
                        self.container_name = data.get("executor_name")
                        self.executor_namespace = data.get("executor_namespace")
                        self.metadata = data

                return SimpleSandbox(data), None
        except Exception as e:
            return None, self._format_http_error(e)


__all__ = [
    # Router
    "ExecutionRouter",
    "ExecutionTarget",
    "CommunicationMode",
    # Dispatcher
    "ExecutionDispatcher",
    "execution_dispatcher",
    # Request Builder
    "TaskRequestBuilder",
    # Schedule Helper
    "schedule_dispatch",
    # Recovery Service
    "ExecutorRecoveryService",
    "recovery_service",
    "get_executor_runtime_client",
    # Emitters - Protocol
    "ResultEmitter",
    "StreamableEmitter",
    # Emitters - Base
    "BaseResultEmitter",
    "QueueBasedEmitter",
    # Emitters - Implementations
    "WebSocketResultEmitter",
    "SSEResultEmitter",
    "DirectSSEEmitter",
    "CallbackResultEmitter",
    "BatchCallbackEmitter",
    "CompositeResultEmitter",
    # Emitters - Factory
    "EmitterType",
    "ResultEmitterFactory",
]
