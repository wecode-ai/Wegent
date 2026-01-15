# SPDX-FileCopyrightText: 2025 WeCode, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Repository layer for Sandbox and Execution persistence.

This module encapsulates all Redis data access for sandbox and execution
objects, separating persistence logic from business logic in SandboxManager.

Redis Data Structure:
- Session Hash: wegent-sandbox-session:{task_id}
  - __sandbox__ field: Sandbox metadata JSON
  - {subtask_id} fields: Execution data JSON
- Active Sandboxes ZSet: wegent-sandbox:active (score = last_activity timestamp)
"""

import json
import time
from typing import Any, Dict, List, Optional, Tuple

import redis
from shared.logger import setup_logger

from executor_manager.common.config import get_config
from executor_manager.common.redis_factory import RedisClientFactory
from executor_manager.common.singleton import SingletonMeta
from executor_manager.models.sandbox import (Execution, ExecutionStatus,
                                             Sandbox, SandboxStatus)

logger = setup_logger(__name__)

# Redis key prefixes
SESSION_HASH_PREFIX = "wegent-sandbox-session:"
SANDBOX_FIELD_NAME = "__sandbox__"
ACTIVE_SANDBOXES_ZSET = "wegent-sandbox:active"


class SandboxRepository(metaclass=SingletonMeta):
    """Repository for Sandbox and Execution persistence.

    This class handles all Redis operations for sandbox and execution data,
    providing a clean separation between persistence and business logic.
    """

    def __init__(self):
        """Initialize the repository."""
        self._config = get_config()
        self._redis_client: Optional[redis.Redis] = None

    @property
    def redis_client(self) -> Optional[redis.Redis]:
        """Lazy-load Redis client."""
        if self._redis_client is None:
            self._redis_client = RedisClientFactory.get_sync_client()
        return self._redis_client

    # =========================================================================
    # Sandbox Operations
    # =========================================================================

    def save_sandbox(self, sandbox: Sandbox) -> bool:
        """Save sandbox metadata to session Hash.

        Stores minimal sandbox info in the __sandbox__ field of the session Hash.

        Args:
            sandbox: Sandbox to save

        Returns:
            True if successful, False otherwise
        """
        if self.redis_client is None:
            logger.error("[SandboxRepository] Redis client not available")
            return False

        try:
            task_id = sandbox.metadata.get("task_id")
            if task_id is None:
                logger.error(
                    "[SandboxRepository] Cannot save sandbox: missing task_id in metadata"
                )
                return False

            sandbox_info = {
                "sandbox_id": sandbox.sandbox_id,
                "container_name": sandbox.container_name,
                "base_url": sandbox.base_url,
                "status": sandbox.status.value,
                "error_message": sandbox.error_message,
                "created_at": sandbox.created_at,
                "shell_type": sandbox.shell_type,
                "user_id": sandbox.user_id,
                "user_name": sandbox.user_name,
                "metadata": sandbox.metadata,
            }

            hash_key = f"{SESSION_HASH_PREFIX}{task_id}"
            data = json.dumps(sandbox_info)
            self.redis_client.hset(hash_key, SANDBOX_FIELD_NAME, data)
            self.redis_client.expire(hash_key, self._config.timeout.redis_ttl)

            # Update active sandboxes ZSet with current timestamp
            self.redis_client.zadd(ACTIVE_SANDBOXES_ZSET, {str(task_id): time.time()})

            return True
        except Exception as e:
            logger.error(f"[SandboxRepository] Failed to save sandbox: {e}")
            return False

    def load_sandbox(self, sandbox_id: str) -> Optional[Sandbox]:
        """Load sandbox by sandbox_id from session Hash.

        Note: sandbox_id is actually the task_id (as string)

        Args:
            sandbox_id: Sandbox ID (which is task_id as string)

        Returns:
            Sandbox if found, None otherwise
        """
        if self.redis_client is None:
            return None

        try:
            task_id = int(sandbox_id)
            hash_key = f"{SESSION_HASH_PREFIX}{task_id}"
            sandbox_data_str = self.redis_client.hget(hash_key, SANDBOX_FIELD_NAME)
            if sandbox_data_str is None:
                return None

            sandbox_info = json.loads(sandbox_data_str)

            container_name = sandbox_info["container_name"]
            base_url = sandbox_info.get("base_url")

            # Determine status: use saved status if available, otherwise infer from base_url
            saved_status = sandbox_info.get("status")
            if saved_status:
                status = SandboxStatus(saved_status)
            elif base_url:
                status = SandboxStatus.RUNNING
            else:
                status = SandboxStatus.PENDING

            sandbox = Sandbox(
                sandbox_id=sandbox_id,
                container_name=container_name,
                shell_type=sandbox_info["shell_type"],
                status=status,
                user_id=sandbox_info["user_id"],
                user_name=sandbox_info["user_name"],
                base_url=base_url,
                created_at=sandbox_info["created_at"],
                started_at=sandbox_info.get("started_at"),
                last_activity_at=sandbox_info.get(
                    "last_activity_at", sandbox_info["created_at"]
                ),
                expires_at=sandbox_info.get("expires_at"),
                error_message=sandbox_info.get("error_message"),
                metadata=sandbox_info.get("metadata", {}),
            )

            return sandbox
        except Exception as e:
            logger.error(
                f"[SandboxRepository] Failed to load sandbox: {e}", exc_info=True
            )
            return None

    def delete_sandbox(self, sandbox_id: str) -> bool:
        """Delete sandbox data from Redis.

        Args:
            sandbox_id: Sandbox ID (task_id as string)

        Returns:
            True if successful, False otherwise
        """
        if self.redis_client is None:
            return False

        try:
            task_id = int(sandbox_id)

            # Remove from active sandboxes ZSet
            self.redis_client.zrem(ACTIVE_SANDBOXES_ZSET, str(task_id))

            # Delete entire session Hash
            hash_key = f"{SESSION_HASH_PREFIX}{task_id}"
            self.redis_client.delete(hash_key)

            logger.debug(
                f"[SandboxRepository] Cleaned Redis for sandbox: sandbox_id={sandbox_id}"
            )
            return True
        except Exception as e:
            logger.error(f"[SandboxRepository] Failed to delete sandbox: {e}")
            return False

    def get_active_sandbox_ids(self) -> List[str]:
        """Get all active sandbox IDs from ZSet.

        Returns:
            List of sandbox IDs (task_id strings)
        """
        if self.redis_client is None:
            return []

        try:
            return self.redis_client.zrange(ACTIVE_SANDBOXES_ZSET, 0, -1)
        except Exception as e:
            logger.error(f"[SandboxRepository] Failed to get active sandboxes: {e}")
            return []

    def get_expired_sandbox_ids(self, max_age_seconds: int) -> List[str]:
        """Get sandbox IDs that have been inactive for longer than max_age.

        Uses ZRANGEBYSCORE to efficiently find sandboxes whose last_activity_timestamp
        is older than the cutoff time.

        Args:
            max_age_seconds: Maximum age in seconds (e.g., 86400 for 24 hours)

        Returns:
            List of expired sandbox IDs
        """
        if self.redis_client is None:
            return []

        try:
            cutoff_timestamp = time.time() - max_age_seconds
            return self.redis_client.zrangebyscore(
                ACTIVE_SANDBOXES_ZSET,
                min=0,
                max=cutoff_timestamp,
            )
        except Exception as e:
            logger.error(f"[SandboxRepository] Failed to get expired sandboxes: {e}")
            return []

    def remove_from_active_set(self, sandbox_id: str) -> bool:
        """Remove a sandbox from the active sandboxes ZSet.

        Args:
            sandbox_id: Sandbox ID to remove

        Returns:
            True if successful, False otherwise
        """
        if self.redis_client is None:
            return False

        try:
            self.redis_client.zrem(ACTIVE_SANDBOXES_ZSET, sandbox_id)
            return True
        except Exception as e:
            logger.error(f"[SandboxRepository] Failed to remove from active set: {e}")
            return False

    def update_activity_timestamp(self, sandbox_id: str) -> bool:
        """Update the last activity timestamp for a sandbox.

        Args:
            sandbox_id: Sandbox ID

        Returns:
            True if successful, False otherwise
        """
        if self.redis_client is None:
            return False

        try:
            self.redis_client.zadd(ACTIVE_SANDBOXES_ZSET, {sandbox_id: time.time()})
            return True
        except Exception as e:
            logger.error(f"[SandboxRepository] Failed to update activity: {e}")
            return False

    # =========================================================================
    # Execution Operations
    # =========================================================================

    def save_execution(self, execution: Execution) -> bool:
        """Save execution to session Hash with field {subtask_id}.

        Args:
            execution: Execution to save

        Returns:
            True if successful, False otherwise
        """
        if self.redis_client is None:
            logger.error(
                "[SandboxRepository] Redis client not available for save_execution"
            )
            return False

        try:
            task_id = execution.metadata.get("task_id", 0)
            subtask_id = execution.metadata.get("subtask_id", 0)

            hash_key = f"{SESSION_HASH_PREFIX}{task_id}"
            field = str(subtask_id)
            data = json.dumps(execution.to_dict())

            logger.info(
                f"[SandboxRepository] Saving execution: hash_key={hash_key}, "
                f"field={field}, execution_id={execution.execution_id}"
            )

            self.redis_client.hset(hash_key, field, data)
            self.redis_client.expire(hash_key, self._config.timeout.redis_ttl)

            # Update active sandboxes ZSet
            self.redis_client.zadd(ACTIVE_SANDBOXES_ZSET, {str(task_id): time.time()})

            logger.info(
                f"[SandboxRepository] Execution saved successfully: task_id={task_id}, subtask_id={subtask_id}"
            )
            return True
        except Exception as e:
            logger.error(f"[SandboxRepository] Failed to save execution: {e}")
            return False

    def load_execution(self, task_id: int, subtask_id: int) -> Optional[Execution]:
        """Load execution from session Hash by task_id and subtask_id.

        Args:
            task_id: Task ID
            subtask_id: Subtask ID

        Returns:
            Execution if found, None otherwise
        """
        if self.redis_client is None:
            logger.error(
                "[SandboxRepository] Redis client not available for load_execution"
            )
            return None

        try:
            hash_key = f"{SESSION_HASH_PREFIX}{task_id}"
            field = str(subtask_id)

            logger.info(
                f"[SandboxRepository] Loading execution: hash_key={hash_key}, field={field}"
            )

            data = self.redis_client.hget(hash_key, field)
            if data is None:
                # Debug: list all fields in hash
                all_fields = self.redis_client.hkeys(hash_key)
                logger.warning(
                    f"[SandboxRepository] Execution not found. Hash {hash_key} has fields: {all_fields}"
                )
                return None

            exec_dict = json.loads(data)
            logger.info(
                f"[SandboxRepository] Execution loaded successfully: execution_id={exec_dict.get('execution_id')}"
            )
            return self._dict_to_execution(exec_dict)
        except Exception as e:
            logger.error(f"[SandboxRepository] Failed to load execution: {e}")
            return None

    def list_executions(self, sandbox_id: str) -> Tuple[List[Execution], Optional[str]]:
        """List all executions in a sandbox.

        Args:
            sandbox_id: Sandbox ID (task_id as string)

        Returns:
            Tuple of (list of Executions, error_message or None)
        """
        if self.redis_client is None:
            return [], "Redis client not initialized"

        try:
            task_id = int(sandbox_id)
            hash_key = f"{SESSION_HASH_PREFIX}{task_id}"

            all_fields = self.redis_client.hgetall(hash_key)
            if not all_fields:
                return [], f"Sandbox {sandbox_id} not found"

            executions = []
            for field, data_str in all_fields.items():
                if field == SANDBOX_FIELD_NAME:
                    continue

                try:
                    exec_dict = json.loads(data_str)
                    executions.append(self._dict_to_execution(exec_dict))
                except Exception as e:
                    logger.debug(
                        f"[SandboxRepository] Failed to parse execution field {field}: {e}"
                    )
                    continue

            return executions, None
        except Exception as e:
            logger.error(f"[SandboxRepository] Failed to list executions: {e}")
            return [], str(e)

    def _dict_to_execution(self, data: Dict[str, Any]) -> Execution:
        """Convert dictionary to Execution object.

        Args:
            data: Dictionary representation

        Returns:
            Execution object
        """
        return Execution(
            execution_id=data["execution_id"],
            sandbox_id=data["sandbox_id"],
            prompt=data["prompt"],
            status=ExecutionStatus(data["status"]),
            result=data.get("result"),
            error_message=data.get("error_message"),
            created_at=data["created_at"],
            started_at=data.get("started_at"),
            completed_at=data.get("completed_at"),
            progress=data.get("progress", 0),
            metadata=data.get("metadata", {}),
        )

    # =========================================================================
    # Executor Binding Operations
    # =========================================================================

    def save_executor_binding(
        self, task_id: int, executor_name: str, ttl: Optional[int] = None
    ) -> bool:
        """Save executor binding for task continuity.

        Args:
            task_id: Task ID
            executor_name: Executor container name
            ttl: TTL in seconds (defaults to config value)

        Returns:
            True if successful, False otherwise
        """
        if self.redis_client is None:
            return False

        try:
            binding_key = f"task_executor:{task_id}"
            binding_value = {
                "executor_name": executor_name,
                "task_id": task_id,
                "created_at": time.time(),
            }

            if ttl is None:
                ttl = self._config.executor.executor_binding_ttl

            self.redis_client.setex(binding_key, ttl, json.dumps(binding_value))
            logger.info(
                f"[SandboxRepository] Stored executor binding: "
                f"task_id={task_id} -> executor={executor_name}, ttl={ttl}s"
            )
            return True
        except Exception as e:
            logger.error(f"[SandboxRepository] Failed to save executor binding: {e}")
            return False

    def load_executor_binding(self, task_id: int) -> Optional[str]:
        """Load executor binding for task continuity.

        Args:
            task_id: Task ID

        Returns:
            Executor name if found, None otherwise
        """
        if self.redis_client is None:
            return None

        try:
            binding_key = f"task_executor:{task_id}"
            binding_json = self.redis_client.get(binding_key)

            if binding_json:
                binding = json.loads(binding_json)
                return binding.get("executor_name")
            return None
        except Exception as e:
            logger.warning(f"[SandboxRepository] Failed to load executor binding: {e}")
            return None


def get_sandbox_repository() -> SandboxRepository:
    """Get the SandboxRepository singleton instance.

    Returns:
        SandboxRepository instance
    """
    return SandboxRepository()
