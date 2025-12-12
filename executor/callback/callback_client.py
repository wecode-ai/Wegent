#!/usr/bin/env python

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# -*- coding: utf-8 -*-

"""
Callback client module, handles communication with the executor_manager callback API
"""

import os
import requests
import time
import json
from typing import Dict, Any, Optional

from executor.config import config

from shared.logger import setup_logger
from shared.status import TaskStatus
from shared.telemetry.config import get_otel_config
from shared.utils.http_util import build_payload
from shared.utils.sensitive_data_masker import mask_sensitive_data

logger = setup_logger("callback_client")


class CallbackClient:
    """Callback client class, responsible for sending callbacks to executor_manager"""

    def __init__(
        self,
        callback_url: str = None,
        timeout: int = 3,
        max_retries: int = 10,
        retry_delay: int = 1,
        retry_backoff: int = 2,
    ):
        """
        Initialize the callback client

        Args:
            callback_url: URL for the callback endpoint. If not provided, will use config.CALLBACK_URL (which supports env override).
            timeout: Request timeout in seconds
            max_retries: Maximum number of retry attempts
            retry_delay: Initial delay between retries in seconds
            retry_backoff: Backoff multiplier for retry delay
        """
        if callback_url is None:
            self.callback_url = config.CALLBACK_URL
        else:
            self.callback_url = callback_url
        self.timeout = timeout
        self.max_retries = max_retries
        self.retry_delay = retry_delay
        self.retry_backoff = retry_backoff

    def _request_with_retry(self, request_func, max_retries=None) -> Dict[str, Any]:
        """
        Generic request retry logic

        Args:
            request_func: Function to execute the request
            max_retries: Maximum number of retries, defaults to self.max_retries

        Returns:
            Tuple of (success, result)
        """
        retries = 0
        delay = self.retry_delay
        retry_limit = max_retries if max_retries is not None else self.max_retries

        while retries <= retry_limit:
            try:
                return request_func()
            except requests.RequestException as e:
                if retries == retry_limit:
                    logger.error(f"Request failed after {retries} retries: {e}")
                    return {"status": TaskStatus.FAILED.value, "error_msg": str(e)}

                logger.warning(
                    f"Request failed (attempt {retries + 1}/{retry_limit}): {e}. Retrying in {delay} seconds..."
                )
                time.sleep(delay)
                retries += 1
                delay *= self.retry_backoff

    def send_callback(
        self,
        task_id: int,
        subtask_id: int,
        task_title: str,
        subtask_title: str,
        progress: int,
        status: Optional[str] = None,
        message: Optional[str] = None,
        executor_name: Optional[str] = None,
        executor_namespace: Optional[str] = None,
        result: Optional[Dict[str, Any]] = None,
        task_type: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        Send a callback to the executor_manager

        Args:
            task_id: The ID of the task
            task_title: The title of the task
            progress: The progress percentage (0-100)
            status: Optional status string
            message: Optional message string
            executor_name: Optional executor name
            executor_namespace: Optional executor namespace
            result: Optional result data dictionary
            task_type: Optional task type (e.g., "validation" for validation tasks)

        Returns:
            Dict[str, Any]: Result returned by the callback interface
        """
        logger.info(
            f"Sending callback: task_id={task_id} subtask_id={subtask_id}, task_title={task_title}, progress={progress}, task_type={task_type}"
        )

        if executor_name is None:
            executor_name = os.getenv("EXECUTOR_NAME")
        if executor_namespace is None:
            executor_namespace = os.getenv("EXECUTOR_NAMESPACE")
        data = build_payload(
            task_id=task_id,
            subtask_id=subtask_id,
            task_title=task_title,
            subtask_title=subtask_title,
            executor_name=executor_name,
            executor_namespace=executor_namespace,
            progress=progress,
        )
        # Add optional fields if provided
        if status:
            data["status"] = status
        if message:
            data["error_message"] = message
        if result:
            data["result"] = result
        if task_type:
            data["task_type"] = task_type

        try:
            return self._request_with_retry(lambda: self._do_send_callback(data))
        except json.JSONDecodeError as e:
            logger.error(f"Failed to parse response data: {e}")
            return {"status": TaskStatus.FAILED.value, "error_msg": str(e)}
        except Exception as e:
            logger.error(f"Unexpected error during send_callback: {e}")
            return {"status": TaskStatus.FAILED.value, "error_msg": str(e)}

    def _do_send_callback(self, data: Dict[str, Any]) -> Dict[str, Any]:
        """
        Execute the callback request

        Args:
            data: The data to send in the request

        Returns:
            Tuple of (success, result)
        """
        # Mask sensitive data in callback payload for logging
        masked_data = mask_sensitive_data(data)
        logger.info("Sending callback to %s, body: %s", self.callback_url, masked_data)

        # Prepare headers with trace context for distributed tracing
        headers = {"Content-Type": "application/json"}
        otel_config = get_otel_config()
        if otel_config.enabled:
            from shared.telemetry.core import is_telemetry_enabled
            from shared.telemetry.context import inject_trace_context_to_headers

            if is_telemetry_enabled():
                headers = inject_trace_context_to_headers(headers)

        # Send original unmasked data
        response = requests.post(
            self.callback_url, json=data, headers=headers, timeout=self.timeout
        )
        return self._handle_response(response)

    def _handle_response(self, response: requests.Response) -> Dict[str, Any]:
        """
        Handle the response from the callback request

        Args:
            response: The response object

        Returns:
            Tuple of (success, result)
        """
        logger.info(
            f"Received response from callback: {response.status_code}, {response.text}"
        )
        if response.status_code in [200, 201, 204]:
            logger.info("Callback sent successfully")
            if response.content:
                return {"status": TaskStatus.SUCCESS.value, "data": response.json()}
            return {"status": TaskStatus.SUCCESS.value}

        elif 400 <= response.status_code < 500:
            error_msg = f"Client error ({response.status_code}) during callback"
            logger.error(
                "error_msg: %s, handele_response: %s", error_msg, response.text
            )
            return {"status": TaskStatus.FAILED.value, "error_msg": error_msg}
        else:
            raise requests.RequestException(
                f"Server error ({response.status_code}) during callback"
            )
