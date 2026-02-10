#!/usr/bin/env python

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# -*- coding: utf-8 -*-

"""
Callback client module, handles communication with the executor_manager callback API.

Uses unified ExecutionEvent format from shared.models.execution for all callbacks.
All legacy callback methods have been removed - use send_event() only.
"""

import json
import time
from typing import Any, Dict

import requests

from executor.config import config
from shared.logger import setup_logger
from shared.models.execution import ExecutionEvent
from shared.status import TaskStatus
from shared.utils.http_client import traced_session
from shared.utils.sensitive_data_masker import mask_sensitive_data

logger = setup_logger("callback_client")


class CallbackClient:
    """Callback client class, responsible for sending callbacks to executor_manager"""

    def __init__(
        self,
        callback_url: str = None,
        timeout: int = 10,
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
        # Traced session auto-injects W3C trace context and X-Request-ID
        self._session = traced_session()

    def _request_with_retry(self, request_func, max_retries=None) -> Dict[str, Any]:
        """
        Generic request retry logic

        Args:
            request_func: Function to execute the request
            max_retries: Maximum number of retries, defaults to self.max_retries

        Returns:
            Dict with status and optional error_msg
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

    def send_event(self, event: ExecutionEvent) -> Dict[str, Any]:
        """
        Send an ExecutionEvent to the executor_manager.

        This is the only method for sending events using the unified format.

        Args:
            event: ExecutionEvent to send

        Returns:
            Dict[str, Any]: Result returned by the callback interface
        """
        logger.info(
            f"Sending event: type={event.type}, task_id={event.task_id}, subtask_id={event.subtask_id}"
        )

        data = event.to_dict()

        try:
            return self._request_with_retry(lambda: self._do_send_callback(data))
        except json.JSONDecodeError as e:
            logger.error(f"Failed to parse response data: {e}")
            return {"status": TaskStatus.FAILED.value, "error_msg": str(e)}
        except Exception as e:
            logger.error(f"Unexpected error during send_event: {e}")
            return {"status": TaskStatus.FAILED.value, "error_msg": str(e)}

    def _do_send_callback(self, data: Dict[str, Any]) -> Dict[str, Any]:
        """
        Execute the callback request

        Args:
            data: The data to send in the request

        Returns:
            Dict with status and optional data/error_msg
        """
        # Mask sensitive data in callback payload for logging
        masked_data = mask_sensitive_data(data)
        logger.info(
            "Sending callback to %s, task_id=%s, status=%s",
            self.callback_url,
            data.get("task_id"),
            data.get("status"),
        )
        logger.debug("Callback body: %s", masked_data)

        # Send original unmasked data (trace context auto-injected by traced session)
        response = self._session.post(
            self.callback_url, json=data, timeout=self.timeout
        )
        return self._handle_response(response)

    def _handle_response(self, response: requests.Response) -> Dict[str, Any]:
        """
        Handle the response from the callback request

        Args:
            response: The response object

        Returns:
            Dict with status and optional data/error_msg
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
            logger.error("error_msg: %s, handle_response: %s", error_msg, response.text)
            return {"status": TaskStatus.FAILED.value, "error_msg": error_msg}
        else:
            raise requests.RequestException(
                f"Server error ({response.status_code}) during callback"
            )
