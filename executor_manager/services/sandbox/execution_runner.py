# SPDX-FileCopyrightText: 2025 WeCode, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Execution runner service with timeout control.

This module handles execution lifecycle including:
- HTTP request to executor container
- Timeout management
- Error handling
- State transition management
"""

import asyncio
from typing import Any, Dict, Optional, Tuple

import httpx
from shared.logger import setup_logger

from executor_manager.common.config import get_config
from executor_manager.common.singleton import SingletonMeta
from executor_manager.models.sandbox import Execution, Sandbox

logger = setup_logger(__name__)


class ExecutionRunner(metaclass=SingletonMeta):
    """Service for running executions with proper timeout control.

    This class handles the execution lifecycle:
    1. Send HTTP request to executor container
    2. Handle timeout via asyncio.wait_for
    3. Manage state transitions
    4. Handle errors and failures
    """

    def __init__(self):
        """Initialize the execution runner."""
        self._config = get_config()

    def build_task_data(
        self,
        sandbox: Sandbox,
        execution: Execution,
        timeout: int,
    ) -> Dict[str, Any]:
        """Build task data for executor container.

        Args:
            sandbox: Parent sandbox
            execution: Execution to run
            timeout: Timeout in seconds

        Returns:
            Task data dictionary for executor
        """
        callback_url = self._config.executor.callback_url

        # Build execution metadata (without bot_config to avoid duplication)
        execution_metadata = {
            "execution_id": execution.execution_id,
            "sandbox_id": sandbox.sandbox_id,
            "task_id": execution.metadata.get("task_id", 0),
            "subtask_id": execution.metadata.get("subtask_id", 0),
            "task_type": execution.metadata.get("task_type"),
        }

        # Get bot_config from execution metadata (passed from kruise_proxy)
        # bot_config should be a list like [{shell_type, agent_config}, ...]
        bot_config = execution.metadata.get("bot_config")

        # If bot_config is provided as a list, use it directly
        # Otherwise, build a minimal bot config from sandbox
        if isinstance(bot_config, list) and bot_config:
            # Use the provided bot_config list directly
            bot = bot_config
        else:
            # Fallback: build minimal bot config from sandbox
            bot = [{"shell_type": sandbox.shell_type}]

        task_data = {
            "task_id": execution.metadata.get("task_id", 0),
            "subtask_id": execution.metadata.get("subtask_id", 0),
            "task_title": "Sandbox Execution",
            "subtask_title": execution.execution_id,
            "type": "sandbox",
            "prompt": execution.prompt,
            "status": "PENDING",
            "progress": 0,
            "bot": bot,
            "user": {
                "id": sandbox.user_id,
                "name": sandbox.user_name,
            },
            "callback_url": callback_url,
            "metadata": execution_metadata,
            "timeout": timeout,
        }

        return task_data

    async def send_execution_request(
        self,
        sandbox: Sandbox,
        execution: Execution,
        timeout: int,
    ) -> Tuple[bool, Optional[str]]:
        """Send execution request to executor container.

        This method sends the execution request with proper timeout handling.
        Uses asyncio.wait_for to enforce timeout at the request level.

        Args:
            sandbox: Parent sandbox
            execution: Execution to run
            timeout: Timeout in seconds

        Returns:
            Tuple of (success, error_message)
        """
        execute_url = f"{sandbox.base_url}/api/tasks/execute"
        task_data = self.build_task_data(sandbox, execution, timeout)

        logger.info(
            f"[ExecutionRunner] Sending execution request to {execute_url}, "
            f"execution_id={execution.execution_id}, timeout={timeout}s"
        )

        try:
            # Use shorter timeout for initial request - executor should accept quickly
            # The actual execution timeout is handled by the executor and callback
            request_timeout = min(
                self._config.timeout.http_execution_request,
                timeout,
            )

            async with httpx.AsyncClient(timeout=request_timeout) as client:
                response = await client.post(execute_url, json=task_data)

                logger.info(
                    f"[ExecutionRunner] Execution response: "
                    f"execution_id={execution.execution_id}, "
                    f"status_code={response.status_code}"
                )

                if response.status_code == 200:
                    result_data = response.json()
                    result_status = result_data.get("status")

                    logger.info(
                        f"[ExecutionRunner] Execution accepted by executor: "
                        f"execution_id={execution.execution_id}, "
                        f"initial_status={result_status}"
                    )
                    return True, None
                else:
                    error_text = response.text
                    logger.error(
                        f"[ExecutionRunner] Executor returned error: "
                        f"status={response.status_code}, body={error_text}"
                    )
                    return (
                        False,
                        f"Executor returned status {response.status_code}: {error_text}",
                    )

        except asyncio.TimeoutError:
            logger.warning(
                f"[ExecutionRunner] Execution request timeout: "
                f"execution_id={execution.execution_id}"
            )
            return False, "Executor container not responding (timeout)"

        except httpx.ConnectError as e:
            logger.error(
                f"[ExecutionRunner] Cannot connect to executor: "
                f"execution_id={execution.execution_id}, error={e}"
            )
            return False, f"Cannot connect to executor container: {e}"

        except Exception as e:
            logger.error(
                f"[ExecutionRunner] Execution error: "
                f"execution_id={execution.execution_id}, error={e}",
                exc_info=True,
            )
            return False, str(e)

    async def run_with_timeout(
        self,
        sandbox: Sandbox,
        execution: Execution,
        timeout: int,
        on_running: Optional[callable] = None,
        on_complete: Optional[callable] = None,
        on_error: Optional[callable] = None,
    ) -> bool:
        """Run execution with timeout control.

        This is the main entry point for running an execution.
        It handles the full lifecycle with proper timeout enforcement.

        Args:
            sandbox: Parent sandbox
            execution: Execution to run
            timeout: Timeout in seconds
            on_running: Callback when execution starts running
            on_complete: Callback when execution is accepted
            on_error: Callback when execution fails

        Returns:
            True if execution was accepted, False if failed
        """
        # Set running status
        execution.set_running()
        if on_running:
            on_running(execution)

        # Send request with timeout
        success, error_message = await self.send_execution_request(
            sandbox, execution, timeout
        )

        if success:
            if on_complete:
                on_complete(execution)
            return True
        else:
            execution.set_failed(error_message or "Unknown error")
            if on_error:
                on_error(execution)
            return False


def get_execution_runner() -> ExecutionRunner:
    """Get the ExecutionRunner singleton instance.

    Returns:
        ExecutionRunner instance
    """
    return ExecutionRunner()
