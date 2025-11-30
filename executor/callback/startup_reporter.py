#!/usr/bin/env python

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# -*- coding: utf-8 -*-

"""
Startup reporter module for notifying executor_manager of container startup
"""

import os
import json
import requests
from typing import Tuple, Optional
from urllib.parse import urlparse, urljoin

from shared.logger import setup_logger

logger = setup_logger("startup_reporter")


class StartupReporter:
    """
    Reports executor startup to executor_manager for restart limit checking.
    """

    def __init__(
        self,
        timeout: int = 5,
        max_retries: int = 3,
        retry_delay: int = 1,
    ):
        """
        Initialize the startup reporter.

        Args:
            timeout: Request timeout in seconds
            max_retries: Maximum number of retry attempts
            retry_delay: Delay between retries in seconds
        """
        self.timeout = timeout
        self.max_retries = max_retries
        self.retry_delay = retry_delay
        self._startup_url = self._build_startup_url()

    def _build_startup_url(self) -> Optional[str]:
        """
        Build the startup API URL from environment variables.

        Uses CALLBACK_URL or CALLBACK_HOST to determine the executor_manager URL.

        Returns:
            The startup API URL or None if not configured
        """
        # Try CALLBACK_URL first (the callback endpoint URL)
        callback_url = os.getenv("CALLBACK_URL", "")
        if callback_url:
            # Parse and replace path with startup endpoint
            parsed = urlparse(callback_url)
            base_url = f"{parsed.scheme}://{parsed.netloc}"
            return f"{base_url}/executor-manager/executor/startup"

        # Try CALLBACK_HOST as fallback
        callback_host = os.getenv("CALLBACK_HOST", "")
        if callback_host:
            if not callback_host.startswith(("http://", "https://")):
                callback_host = f"http://{callback_host}"
            return f"{callback_host}/executor-manager/executor/startup"

        # Try EXECUTOR_MANAGER_URL as another fallback
        manager_url = os.getenv("EXECUTOR_MANAGER_URL", "")
        if manager_url:
            if not manager_url.startswith(("http://", "https://")):
                manager_url = f"http://{manager_url}"
            return f"{manager_url}/executor-manager/executor/startup"

        return None

    def report_startup(
        self,
        task_id: int,
        subtask_id: int,
        executor_name: Optional[str] = None,
    ) -> Tuple[bool, dict]:
        """
        Report executor startup and check if execution is allowed.

        Args:
            task_id: The task ID
            subtask_id: The subtask ID
            executor_name: The executor container name (from env if not provided)

        Returns:
            Tuple of (allowed, response_data)
            - allowed: True if execution should proceed, False if restart limit exceeded
            - response_data: Response from executor_manager containing restart count info
        """
        if not self._startup_url:
            logger.warning(
                "Startup URL not configured, allowing execution (fail-open)"
            )
            return True, {
                "allowed": True,
                "restart_count": 0,
                "max_restart": 0,
                "message": "Startup URL not configured"
            }

        if executor_name is None:
            executor_name = os.getenv("EXECUTOR_NAME", "unknown")

        payload = {
            "task_id": task_id,
            "subtask_id": subtask_id,
            "executor_name": executor_name,
        }

        logger.info(
            f"Reporting startup to executor_manager: task_id={task_id}, "
            f"subtask_id={subtask_id}, executor_name={executor_name}"
        )

        # Retry logic
        last_error = None
        for attempt in range(self.max_retries):
            try:
                response = requests.post(
                    self._startup_url,
                    json=payload,
                    timeout=self.timeout,
                )

                if response.status_code == 200:
                    data = response.json()
                    allowed = data.get("allowed", True)
                    logger.info(
                        f"Startup check result: allowed={allowed}, "
                        f"restart_count={data.get('restart_count', 0)}/{data.get('max_restart', 0)}"
                    )
                    return allowed, data
                else:
                    error_msg = f"Startup API returned status {response.status_code}: {response.text}"
                    logger.warning(error_msg)
                    last_error = error_msg

            except requests.Timeout as e:
                last_error = f"Request timeout: {e}"
                logger.warning(f"Startup report attempt {attempt + 1} failed: {last_error}")
            except requests.RequestException as e:
                last_error = f"Request failed: {e}"
                logger.warning(f"Startup report attempt {attempt + 1} failed: {last_error}")
            except json.JSONDecodeError as e:
                last_error = f"Invalid JSON response: {e}"
                logger.warning(f"Startup report attempt {attempt + 1} failed: {last_error}")
            except Exception as e:
                last_error = f"Unexpected error: {e}"
                logger.warning(f"Startup report attempt {attempt + 1} failed: {last_error}")

            # Wait before retry (except on last attempt)
            if attempt < self.max_retries - 1:
                import time
                time.sleep(self.retry_delay)

        # All retries failed - use fail-open strategy
        logger.warning(
            f"All {self.max_retries} startup report attempts failed: {last_error}. "
            f"Allowing execution (fail-open)"
        )
        return True, {
            "allowed": True,
            "restart_count": 0,
            "max_restart": 0,
            "message": f"Startup report failed: {last_error}"
        }


def check_startup_allowed() -> Tuple[bool, dict]:
    """
    Check if executor startup is allowed by reading TASK_INFO and reporting to manager.

    This is a convenience function for use in the executor lifespan.

    Returns:
        Tuple of (allowed, response_data)
    """
    task_info = os.getenv("TASK_INFO")
    if not task_info:
        logger.info("No TASK_INFO found, skipping startup check")
        return True, {"allowed": True, "message": "No TASK_INFO"}

    try:
        task_data = json.loads(task_info)
        task_id = task_data.get("task_id", -1)
        subtask_id = task_data.get("subtask_id", -1)

        if task_id < 0 or subtask_id < 0:
            logger.warning(
                f"Invalid task_id ({task_id}) or subtask_id ({subtask_id}), allowing execution"
            )
            return True, {"allowed": True, "message": "Invalid task/subtask ID"}

        reporter = StartupReporter()
        return reporter.report_startup(task_id, subtask_id)

    except json.JSONDecodeError as e:
        logger.error(f"Failed to parse TASK_INFO: {e}")
        return True, {"allowed": True, "message": f"Invalid TASK_INFO: {e}"}
    except Exception as e:
        logger.error(f"Error during startup check: {e}")
        return True, {"allowed": True, "message": f"Error: {e}"}
