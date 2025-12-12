#!/usr/bin/env python

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# -*- coding: utf-8 -*-

"""
API client module, handles communication with the API
"""

import json
import time

import requests
from shared.logger import setup_logger
from shared.utils.http_util import build_payload

from executor_manager.config.config import (API_MAX_RETRIES, API_RETRY_BACKOFF,
                                            API_RETRY_DELAY, API_TIMEOUT,
                                            CALLBACK_TASK_API_URL,
                                            FETCH_TASK_API_BASE_URL,
                                            OFFLINE_TASK_FETCH_LIMIT,
                                            TASK_FETCH_LIMIT,
                                            TASK_FETCH_STATUS)
# Import the shared logger
from executor_manager.executors.dispatcher import ExecutorDispatcher

logger = setup_logger(__name__)


class TaskApiClient:
    """API client class, responsible for communicating with task API"""

    def __init__(
        self,
        timeout=API_TIMEOUT,
        max_retries=API_MAX_RETRIES,
        retry_delay=API_RETRY_DELAY,
        retry_backoff=API_RETRY_BACKOFF,
        limit=TASK_FETCH_LIMIT,
        task_status=TASK_FETCH_STATUS,
        offline_limit=OFFLINE_TASK_FETCH_LIMIT,
    ):
        self.fetch_task_api_base_url = FETCH_TASK_API_BASE_URL
        self.callback_task_api_url = CALLBACK_TASK_API_URL
        self.limit = limit
        self.task_status = task_status
        self.offline_limit = offline_limit
        self.timeout = timeout
        self.max_retries = max_retries
        self.retry_delay = retry_delay
        self.retry_backoff = retry_backoff

    def _request_with_retry(self, request_func, max_retries=None):
        """Generic request retry logic"""
        retries = 0
        delay = self.retry_delay
        retry_limit = max_retries if max_retries is not None else self.max_retries

        while retries <= retry_limit:
            try:
                return request_func()
            except requests.RequestException as e:
                if retries == retry_limit:
                    logger.error(f"Request failed after {retries} retries: {e}")
                    return False, str(e)

                logger.warning(
                    f"Request failed (attempt {retries + 1}/{retry_limit}): {e}. Retrying in {delay} seconds..."
                )
                time.sleep(delay)
                retries += 1
                delay *= self.retry_backoff
        return None

    def fetch_tasks(self):
        """Fetch tasks from API"""
        logger.info("Fetching tasks...")
        try:
            return self._request_with_retry(self._do_fetch_tasks, max_retries=1)
        except json.JSONDecodeError as e:
            logger.error(f"Failed to parse response data: {e}")
            return False, str(e)
        except Exception as e:
            logger.error(f"Unexpected error during fetch_tasks: {e}")
            return False, str(e)

    def _do_fetch_tasks(self):
        # Build URL with query parameters
        url = f"{self.fetch_task_api_base_url}?limit={self.limit}&task_status={self.task_status}"
        logger.info(f"Fetching tasks from: {url}")
        response = requests.post(url, timeout=self.timeout)
        return self._handle_response(
            response, expect_json=True, context="fetching tasks"
        )
        
    def update_fetch_params(self, limit=None, task_status=None):
        """Update task fetch parameters"""
        if limit is not None:
            self.limit = limit
        if task_status is not None:
            self.task_status = task_status
        logger.info(f"Updated fetch parameters: limit={self.limit}, task_status={self.task_status}")

    def update_task_status_by_fields(self, task_id, subtask_id, progress=0, **kwargs):
        """Update task status in API"""
        executor_name = kwargs.get("executor_name")
        executor_namespace = kwargs.get("executor_namespace")
        status = kwargs.get("status")
        error_message = kwargs.get("error_message")
        result = kwargs.get("result")
        title = kwargs.get("title")

        logger.info(
            f"Updating task status: ID={task_id}, executor_namespace={executor_namespace}, executor_name={executor_name}, Progress={progress}%, status={status}"
        )

        data = build_payload(
            task_id=task_id,
            subtask_id=subtask_id,
            executor_name=executor_name,
            executor_namespace=executor_namespace,
            progress=progress,
            status=status,
            error_message=error_message,
            result=result,
            title=title,
        )

        try:
            return self.update_task_status(data)
        except json.JSONDecodeError as e:
            logger.error(f"Failed to parse response data: {e}")
            return False, str(e)
        except Exception as e:
            logger.error(f"Unexpected error during update_task_status: {e}")
            return False, str(e)

    def update_task_status(self, data: dict):
        """Update task status in API with a dict parameter"""
        logger.info(f"Updating task status with dict: {data}")

        try:
            return self._request_with_retry(lambda: self._do_update_task_status(data))
        except json.JSONDecodeError as e:
            logger.error(f"Failed to parse response data: {e}")
            return False, str(e)
        except Exception as e:
            logger.error(f"Unexpected error during update_task_status_by_dict: {e}")
            return False, str(e)

    def _do_update_task_status(self, data):
        task_id = data["task_id"]
        url = f"{self.callback_task_api_url}?task_id={task_id}"
        response = requests.put(url, json=data, timeout=self.timeout)
        return self._handle_response(
            response, expect_json=True, context=f"updating status for task {task_id}"
        )

    def _handle_response(self, response, expect_json=False, context="API request"):
        """Common response handler"""
        logger.info(f"Received response: {response.status_code}, {response.text}")
        if response.status_code in [200, 201, 204]:
            logger.info(f"Success: {context}")
            if expect_json and response.content:
                return True, response.json()
            return False, {"error_msg": "No content in response"}

        elif 400 <= response.status_code < 500:
            error_msg = f"Client error ({response.status_code}) during {context}"
            logger.error(error_msg)
            return False, {"error_msg": error_msg}

        else:
            raise requests.RequestException(
                f"Server error ({response.status_code}) during {context}"
            )
            
    def fetch_subtasks(self, task_id):
        """Fetch subtasks for a specific task ID"""
        logger.info(f"Fetching subtasks for task ID: {task_id}")
        try:
            return self._request_with_retry(lambda: self._do_fetch_subtasks(task_id), max_retries=1)
        except json.JSONDecodeError as e:
            logger.error(f"Failed to parse response data: {e}")
            return False, str(e)
        except Exception as e:
            logger.error(f"Unexpected error during fetch_subtasks: {e}")
            return False, str(e)
            
    def _do_fetch_subtasks(self, task_id):
        """Execute the API request to fetch subtasks for a specific task ID"""
        # Build URL with query parameters
        url = f"{self.fetch_task_api_base_url}?task_ids={task_id}&task_status={self.task_status}"
        logger.info(f"Fetching subtasks from: {url}")
        response = requests.post(url, timeout=self.timeout)
        return self._handle_response(
            response, expect_json=True, context=f"fetching subtasks for task {task_id}"
        )
    
    def fetch_offline_tasks(self):
        """Fetch offline tasks from API"""
        logger.info("Fetching offline tasks...")
        try:
            return self._request_with_retry(self._do_fetch_offline_tasks, max_retries=1)
        except json.JSONDecodeError as e:
            logger.error(f"Failed to parse response data: {e}")
            return False, str(e)
        except Exception as e:
            logger.error(f"Unexpected error during fetch_offline_tasks: {e}")
            return False, str(e)
    
    def _do_fetch_offline_tasks(self):
        """Execute the API request to fetch offline tasks"""
        # Build URL with query parameters for offline tasks
        url = f"{self.fetch_task_api_base_url}?limit={self.offline_limit}&task_status={self.task_status}&type=offline"
        logger.info(f"Fetching offline tasks from: {url}")
        response = requests.post(url, timeout=self.timeout)
        return self._handle_response(
            response, expect_json=True, context="fetching offline tasks"
        )
    
    def update_offline_fetch_params(self, limit=None):
        """Update offline task fetch parameters"""
        if limit is not None:
            self.offline_limit = limit
        logger.info(f"Updated offline fetch parameters: limit={self.offline_limit}")
