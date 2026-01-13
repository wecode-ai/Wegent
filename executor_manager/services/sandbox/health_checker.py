# SPDX-FileCopyrightText: 2025 WeCode, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Container health checking service.

This module provides health checking functionality for executor containers,
separating health monitoring concerns from the main SandboxManager.
"""

import asyncio
from typing import Optional

import httpx
from shared.logger import setup_logger

from executor_manager.common.config import get_config
from executor_manager.common.singleton import SingletonMeta
from executor_manager.executors.docker.utils import get_container_ports

logger = setup_logger(__name__)


class ContainerHealthChecker(metaclass=SingletonMeta):
    """Service for checking container health status.

    This class encapsulates all container health checking logic,
    including HTTP health endpoints and port availability checks.
    """

    def __init__(self):
        """Initialize the health checker."""
        self._config = get_config()

    def check_health_sync(self, base_url: str) -> bool:
        """Check if container is healthy (synchronous).

        Args:
            base_url: Container base URL (e.g., http://localhost:8080)

        Returns:
            True if container is healthy, False otherwise
        """
        try:
            response = httpx.get(
                f"{base_url}/",
                timeout=self._config.timeout.http_health_check,
            )
            return response.status_code == 200
        except Exception as e:
            logger.debug(
                f"[ContainerHealthChecker] Health check failed for {base_url}: {e}"
            )
            return False

    async def check_health_async(self, port: int) -> bool:
        """Check if container is healthy (asynchronous).

        Args:
            port: Container's host port

        Returns:
            True if container is healthy, False otherwise
        """
        host = self._config.executor.docker_host
        url = f"http://{host}:{port}/"
        try:
            async with httpx.AsyncClient(
                timeout=self._config.timeout.http_health_check
            ) as client:
                response = await client.get(url)
                logger.info(
                    f"[ContainerHealthChecker] Health check {url} -> "
                    f"status={response.status_code}"
                )
                return response.status_code == 200
        except Exception as e:
            logger.info(
                f"[ContainerHealthChecker] Async health check failed for {url}: {e}"
            )
            return False

    async def wait_for_container_ready(
        self,
        container_name: str,
        max_wait: Optional[int] = None,
    ) -> Optional[int]:
        """Wait for container to be ready and return its port.

        Args:
            container_name: Name of the container
            max_wait: Maximum seconds to wait (defaults to config value)

        Returns:
            Port number if ready, None if timeout
        """
        if max_wait is None:
            max_wait = self._config.timeout.container_ready

        start_time = asyncio.get_event_loop().time()
        logger.info(
            f"[ContainerHealthChecker] Waiting for container {container_name} "
            f"to be ready (max_wait={max_wait}s)"
        )

        while asyncio.get_event_loop().time() - start_time < max_wait:
            try:
                port_result = get_container_ports(container_name)
                if port_result.get("status") == "success":
                    ports = port_result.get("ports", [])
                    if ports:
                        port = ports[0].get("host_port")
                        if port:
                            # Health check the container using / endpoint
                            is_healthy = await self.check_health_async(port)
                            logger.info(
                                f"[ContainerHealthChecker] Health check for {container_name} "
                                f"on port {port}: healthy={is_healthy}"
                            )
                            if is_healthy:
                                logger.info(
                                    f"[ContainerHealthChecker] Container ready: "
                                    f"{container_name} on port {port}"
                                )
                                return port
            except Exception as e:
                logger.debug(f"[ContainerHealthChecker] Waiting for container: {e}")

            await asyncio.sleep(1)

        logger.warning(
            f"[ContainerHealthChecker] Container {container_name} did not become ready "
            f"within {max_wait}s"
        )
        return None


def get_container_health_checker() -> ContainerHealthChecker:
    """Get the ContainerHealthChecker singleton instance.

    Returns:
        ContainerHealthChecker instance
    """
    return ContainerHealthChecker()
