#!/usr/bin/env python

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# -*- coding: utf-8 -*-

"""Code Tool Session Manager for managing Docker containers for code execution."""

import asyncio
import json
import os
import shutil
import subprocess
from collections.abc import AsyncGenerator
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Optional

import httpx
from shared.logger import setup_logger

logger = setup_logger("code_tool_session_manager")


@dataclass
class ContainerInfo:
    """Container information."""

    container_id: str
    session_id: str
    port: int
    work_dir: str
    created_at: datetime
    last_active: datetime


@dataclass
class ContainerConfig:
    """Container configuration."""

    memory_limit: str = "1g"
    cpu_limit: float = 2.0
    timeout: int = 300


@dataclass
class StreamEvent:
    """Stream event for SSE responses."""

    event_type: str
    data: dict[str, Any] = field(default_factory=dict)
    timestamp: datetime = field(default_factory=datetime.now)

    def json(self) -> str:
        """Convert to JSON string."""
        return json.dumps(
            {
                "event_type": self.event_type,
                "data": self.data,
                "timestamp": self.timestamp.isoformat(),
            }
        )


class CodeToolSessionManager:
    """
    Manages Chat Session -> Docker Container mappings.

    Reuses existing DockerExecutor's container management capabilities but
    specifically for Code Tool use cases where containers persist across
    multiple chat turns within the same session.
    """

    _instance: Optional["CodeToolSessionManager"] = None
    _lock: asyncio.Lock = asyncio.Lock()

    def __new__(cls):
        if cls._instance is None:
            cls._instance = super().__new__(cls)
            cls._instance._initialized = False
        return cls._instance

    def __init__(self):
        if self._initialized:
            return
        self._initialized = True
        self._sessions: dict[str, ContainerInfo] = {}
        self._port_range_start = 9100
        self._port_range_end = 9200
        self._used_ports: set[int] = set()
        self._executor_image = os.getenv("EXECUTOR_IMAGE", "wegent/executor:latest")
        self._temp_dir = os.getenv("CODE_TOOL_TEMP_DIR", "/tmp/code-tool")
        self._memory_limit = os.getenv("CODE_TOOL_MEMORY_LIMIT", "1g")
        self._cpu_limit = float(os.getenv("CODE_TOOL_CPU_LIMIT", "2.0"))

    def _get_available_port(self) -> int:
        """Get an available port for container."""
        for port in range(self._port_range_start, self._port_range_end):
            if port not in self._used_ports:
                self._used_ports.add(port)
                return port
        raise RuntimeError("No available ports for code tool containers")

    def _release_port(self, port: int) -> None:
        """Release a port back to the pool."""
        self._used_ports.discard(port)

    async def _is_healthy(self, container: ContainerInfo) -> bool:
        """Check if container is healthy."""
        try:
            # Check if container is running
            result = subprocess.run(
                ["docker", "inspect", "-f", "{{.State.Running}}", container.container_id],
                capture_output=True,
                text=True,
                timeout=5,
            )
            if result.returncode != 0 or result.stdout.strip() != "true":
                return False

            # Check if API is responsive
            try:
                async with httpx.AsyncClient(timeout=5) as client:
                    response = await client.get(
                        f"http://localhost:{container.port}/health"
                    )
                    return response.status_code == 200
            except Exception:
                return False

        except Exception as e:
            logger.warning(f"Health check failed for {container.container_id}: {e}")
            return False

    async def _cleanup_container(self, container: ContainerInfo) -> None:
        """Clean up a container."""
        try:
            # Stop and remove container
            subprocess.run(
                ["docker", "rm", "-f", container.container_id],
                capture_output=True,
                timeout=30,
            )
            logger.info(f"Removed container {container.container_id}")

            # Release port
            self._release_port(container.port)

            # Clean up work directory
            if os.path.exists(container.work_dir):
                shutil.rmtree(container.work_dir)
                logger.info(f"Cleaned up work dir {container.work_dir}")

        except Exception as e:
            logger.warning(f"Error cleaning up container {container.container_id}: {e}")

    async def get_or_create_container(
        self,
        session_id: str,
        config: Optional[ContainerConfig] = None,
    ) -> ContainerInfo:
        """Get existing container or create a new one for session."""
        async with self._lock:
            # Check for existing container
            if session_id in self._sessions:
                container = self._sessions[session_id]
                if await self._is_healthy(container):
                    container.last_active = datetime.now()
                    logger.info(
                        f"Reusing container {container.container_id} for session {session_id}"
                    )
                    return container
                else:
                    # Container not healthy, clean up and recreate
                    logger.warning(
                        f"Container {container.container_id} unhealthy, recreating"
                    )
                    await self._cleanup_container(container)
                    del self._sessions[session_id]

            # Create new container
            container = await self._create_container(session_id, config)
            self._sessions[session_id] = container
            return container

    async def _create_container(
        self,
        session_id: str,
        config: Optional[ContainerConfig] = None,
    ) -> ContainerInfo:
        """Create a new container for code tool execution."""
        config = config or ContainerConfig()
        container_name = f"code-tool-{session_id}"

        # Prepare directories
        work_dir = os.path.join(self._temp_dir, session_id)
        input_dir = os.path.join(work_dir, "input")
        output_dir = os.path.join(work_dir, "output")
        os.makedirs(input_dir, exist_ok=True)
        os.makedirs(output_dir, exist_ok=True)

        # Get available port
        port = self._get_available_port()

        # Build docker run command
        cmd = [
            "docker",
            "run",
            "-d",
            "--name",
            container_name,
            "--label",
            "type=code-tool",
            "--label",
            f"session_id={session_id}",
            "-p",
            f"{port}:8080",
            "-v",
            f"{input_dir}:/workspace/input",
            "-v",
            f"{output_dir}:/workspace/output",
            "-m",
            self._memory_limit,
            "--cpus",
            str(self._cpu_limit),
            "-e",
            "MODE=code-tool",
            "-e",
            f"SESSION_ID={session_id}",
            "-e",
            f"ANTHROPIC_API_KEY={os.getenv('ANTHROPIC_API_KEY', '')}",
            "-e",
            f"CODE_TOOL_MODEL_PROVIDER={os.getenv('CODE_TOOL_MODEL_PROVIDER', 'anthropic')}",
            "-e",
            f"CODE_TOOL_MODEL_NAME={os.getenv('CODE_TOOL_MODEL_NAME', 'claude-sonnet-4-20250514')}",
            self._executor_image,
        ]

        logger.info(f"Creating container for session {session_id}: {container_name}")

        try:
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=60,
            )

            if result.returncode != 0:
                error_msg = result.stderr.strip() or "Unknown error"
                logger.error(f"Failed to create container: {error_msg}")
                self._release_port(port)
                raise RuntimeError(f"Failed to create container: {error_msg}")

            # Wait for container to be ready
            await self._wait_for_ready(container_name, port)

            container = ContainerInfo(
                container_id=container_name,
                session_id=session_id,
                port=port,
                work_dir=work_dir,
                created_at=datetime.now(),
                last_active=datetime.now(),
            )

            logger.info(f"Created container {container_name} on port {port}")
            return container

        except subprocess.TimeoutExpired:
            logger.error("Container creation timed out")
            self._release_port(port)
            raise RuntimeError("Container creation timed out")

    async def _wait_for_ready(
        self, container_name: str, port: int, timeout: int = 60
    ) -> None:
        """Wait for container to be ready."""
        start_time = datetime.now()

        while (datetime.now() - start_time).total_seconds() < timeout:
            try:
                async with httpx.AsyncClient(timeout=2) as client:
                    response = await client.get(f"http://localhost:{port}/health")
                    if response.status_code == 200:
                        logger.info(f"Container {container_name} is ready")
                        return
            except Exception:
                pass

            await asyncio.sleep(1)

        raise RuntimeError(f"Container {container_name} failed to become ready")

    async def execute_in_container(
        self,
        session_id: str,
        prompt: str,
        system_prompt: Optional[str],
        input_files: list[str],
        timeout: int,
        user_id: int,
    ) -> AsyncGenerator[StreamEvent, None]:
        """Execute code tool request in container."""
        container = await self.get_or_create_container(session_id)

        # Copy input files to container
        for file_path in input_files:
            if os.path.exists(file_path):
                await self._copy_file_to_container(
                    container.container_id,
                    file_path,
                    f"/workspace/input/{os.path.basename(file_path)}",
                )

        # Generate unique request ID
        import uuid

        request_id = str(uuid.uuid4())

        # Call container API
        url = f"http://localhost:{container.port}/api/code-tool/execute"
        request_data = {
            "session_id": session_id,
            "request_id": request_id,
            "prompt": prompt,
            "system_prompt": system_prompt,
            "input_files": [f"/workspace/input/{os.path.basename(f)}" for f in input_files],
            "timeout": timeout,
        }

        logger.info(f"Executing code tool for session {session_id}, request {request_id}")

        try:
            async with httpx.AsyncClient() as client:
                async with client.stream(
                    "POST",
                    url,
                    json=request_data,
                    timeout=httpx.Timeout(timeout + 60, connect=30),
                ) as response:
                    response.raise_for_status()

                    async for line in response.aiter_lines():
                        if not line:
                            continue

                        if line.startswith("data: "):
                            try:
                                data = json.loads(line[6:])
                                yield StreamEvent(
                                    event_type=data.get("event_type", "text"),
                                    data=data.get("data", {}),
                                    timestamp=datetime.fromisoformat(data["timestamp"])
                                    if "timestamp" in data
                                    else datetime.now(),
                                )
                            except json.JSONDecodeError as e:
                                logger.warning(f"Failed to parse SSE data: {e}")

            # Update last active
            container.last_active = datetime.now()

        except httpx.TimeoutException:
            logger.error(f"Timeout executing code tool for session {session_id}")
            yield StreamEvent(
                event_type="error",
                data={"message": "Execution timed out", "code": "TIMEOUT"},
            )
        except Exception as e:
            logger.exception(f"Error executing code tool: {e}")
            yield StreamEvent(
                event_type="error",
                data={"message": str(e), "code": "EXECUTION_ERROR"},
            )

    async def _copy_file_to_container(
        self,
        container_id: str,
        source_path: str,
        target_path: str,
    ) -> None:
        """Copy a file to the container."""
        try:
            cmd = ["docker", "cp", source_path, f"{container_id}:{target_path}"]
            result = subprocess.run(cmd, capture_output=True, timeout=30)
            if result.returncode != 0:
                logger.warning(f"Failed to copy {source_path} to container: {result.stderr}")
        except Exception as e:
            logger.warning(f"Error copying file to container: {e}")

    async def get_session_info(self, session_id: str) -> Optional[dict[str, Any]]:
        """Get session information."""
        if session_id not in self._sessions:
            return None

        container = self._sessions[session_id]
        is_healthy = await self._is_healthy(container)

        return {
            "session_id": session_id,
            "container_id": container.container_id,
            "status": "running" if is_healthy else "stopped",
            "created_at": container.created_at.isoformat(),
            "last_active": container.last_active.isoformat(),
            "port": container.port,
        }

    async def destroy_session(self, session_id: str) -> bool:
        """Destroy a session and its container."""
        if session_id not in self._sessions:
            return True

        container = self._sessions.pop(session_id)
        await self._cleanup_container(container)
        return True

    async def cleanup_inactive_sessions(self, max_idle_minutes: int = 30) -> int:
        """Clean up sessions that have been idle for too long."""
        now = datetime.now()
        to_cleanup = []

        for session_id, container in self._sessions.items():
            idle_time = (now - container.last_active).total_seconds() / 60
            if idle_time > max_idle_minutes:
                to_cleanup.append(session_id)

        cleaned = 0
        for session_id in to_cleanup:
            try:
                await self.destroy_session(session_id)
                cleaned += 1
                logger.info(f"Cleaned up inactive session: {session_id}")
            except Exception as e:
                logger.warning(f"Failed to cleanup session {session_id}: {e}")

        return cleaned


# Singleton instance
session_manager = CodeToolSessionManager()
