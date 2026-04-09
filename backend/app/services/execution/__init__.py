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


def get_sandbox_manager():
    """Get the SandboxManager instance for creating sandboxes.

    Returns:
        SandboxManager instance from executor_manager service
    """
    import httpx

    from app.core.config import settings

    # For recovery, we need to call executor_manager's sandbox API
    # This is a thin wrapper that will be replaced with direct call
    # when executor_manager is properly integrated
    return _SandboxManagerClient()


class _SandboxManagerClient:
    """Thin client for calling executor_manager sandbox API."""

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
    "get_sandbox_manager",
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
