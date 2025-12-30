#!/usr/bin/env python

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# -*- coding: utf-8 -*-

"""
Preview Proxy for forwarding HTTP requests to preview services in containers.

This module handles proxying requests from the frontend to the dev server
running inside executor containers.
"""

import subprocess
from typing import Optional, Tuple

import httpx
from shared.logger import setup_logger

from executor_manager.executors.docker.utils import find_container_for_task

logger = setup_logger(__name__)


class PreviewProxy:
    """
    Proxy for forwarding HTTP requests to preview services.

    Handles the translation of external requests to internal container ports.
    """

    def __init__(self):
        self._port_cache: dict[int, int] = {}  # task_id -> host_port

    def _get_container_ip(self, container_name: str) -> Optional[str]:
        """Get the IP address of a container"""
        try:
            cmd = [
                "docker",
                "inspect",
                "-f",
                "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}",
                container_name,
            ]
            result = subprocess.run(cmd, check=True, capture_output=True, text=True)
            ip = result.stdout.strip()
            return ip if ip else None

        except subprocess.CalledProcessError as e:
            logger.exception(f"Error getting container IP for {container_name}: {e}")
            return None

    async def get_proxy_target(self, task_id: int, port: int) -> Tuple[Optional[str], Optional[str]]:
        """
        Get the proxy target URL for a task's preview service.

        Returns: (target_url, error_message)
        """
        container_name = find_container_for_task(task_id)
        if not container_name:
            return None, "Container not running"

        container_ip = self._get_container_ip(container_name)
        if not container_ip:
            return None, "Could not determine container IP"

        return f"http://{container_ip}:{port}", None

    async def proxy_request(
        self,
        task_id: int,
        port: int,
        method: str,
        path: str,
        headers: dict,
        body: Optional[bytes] = None,
    ) -> Tuple[Optional[httpx.Response], Optional[str]]:
        """
        Proxy an HTTP request to the preview service.

        Returns: (response, error_message)
        """
        target_url, error = await self.get_proxy_target(task_id, port)
        if error:
            return None, error

        # Build the full URL
        full_url = f"{target_url}{path}"

        # Filter headers that shouldn't be proxied
        proxy_headers = {}
        skip_headers = {"host", "connection", "content-length", "transfer-encoding"}
        for key, value in headers.items():
            if key.lower() not in skip_headers:
                proxy_headers[key] = value

        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                response = await client.request(
                    method=method,
                    url=full_url,
                    headers=proxy_headers,
                    content=body,
                    follow_redirects=False,
                )
                return response, None

        except httpx.TimeoutException:
            return None, "Request timeout"
        except httpx.ConnectError:
            return None, "Could not connect to preview service"
        except Exception as e:
            logger.exception(f"Error proxying request: {e}")
            return None, str(e)


# Singleton instance
preview_proxy = PreviewProxy()
