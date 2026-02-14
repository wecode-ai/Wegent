#!/usr/bin/env python

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# -*- coding: utf-8 -*-

"""
API client module, handles communication with the API
"""

import requests

from executor_manager.config.config import (
    API_TIMEOUT,
    TASK_API_DOMAIN,
)

# Import the shared logger
from shared.logger import setup_logger
from shared.utils.http_client import traced_session

logger = setup_logger(__name__)


class TaskApiClient:
    """API client class, responsible for communicating with task API"""

    def __init__(
        self,
        timeout=API_TIMEOUT,
    ):
        self.task_api_domain = TASK_API_DOMAIN
        self.timeout = timeout
        # Traced session auto-injects W3C trace context and X-Request-ID
        self._session = traced_session()

    def get_task_status(self, task_id: int, subtask_id: int) -> dict | None:
        """Get current status of a specific task/subtask from Backend.

        Args:
            task_id: Task ID
            subtask_id: Subtask ID

        Returns:
            dict with task status info or None if failed/not found
            Example: {"status": "RUNNING", "progress": 50, ...}
        """
        try:
            url = f"{self.task_api_domain}/api/tasks/{task_id}/subtasks/{subtask_id}"
            logger.debug(f"Getting task status from: {url}")

            response = self._session.get(url, timeout=self.timeout)

            if response.status_code == 200:
                return response.json()
            elif response.status_code == 404:
                logger.warning(f"Task {task_id}/{subtask_id} not found")
                return None
            else:
                logger.warning(
                    f"Failed to get task status: {response.status_code} {response.text}"
                )
                return None
        except Exception as e:
            logger.error(f"Error getting task status for {task_id}/{subtask_id}: {e}")
            return None
