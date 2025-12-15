#!/usr/bin/env python

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# -*- coding: utf-8 -*-

"""
Persistent container manager for long-running containers
"""

import os
import subprocess
import time
from datetime import datetime
from typing import Any, Dict, Optional

from shared.logger import setup_logger
from executor_manager.executors.docker.utils import (
    find_available_port,
    delete_container,
    build_callback_url,
)
from executor_manager.executors.docker.constants import (
    CONTAINER_OWNER,
    DEFAULT_TIMEZONE,
    DEFAULT_LOCALE,
    DOCKER_SOCKET_PATH,
    WORKSPACE_MOUNT_PATH,
)
from executor_manager.config.config import EXECUTOR_ENV

logger = setup_logger(__name__)


def convert_memory_format(memory: str) -> str:
    """
    Convert Kubernetes-style memory format to Docker format.
    
    Kubernetes uses: Ki, Mi, Gi, Ti (binary) or K, M, G, T (decimal)
    Docker uses: b, k, m, g (case-insensitive)
    
    Examples:
        4Gi -> 4g
        512Mi -> 512m
        1024Ki -> 1024k
        2G -> 2g
        
    Args:
        memory: Memory string in Kubernetes or Docker format
        
    Returns:
        Memory string in Docker format
    """
    if not memory:
        return memory
    
    memory = memory.strip()
    
    # Already in Docker format (ends with single letter b/k/m/g)
    if memory[-1].lower() in ('b', 'k', 'm', 'g') and (len(memory) < 2 or memory[-2].isdigit()):
        return memory
    
    # Kubernetes binary format: Ki, Mi, Gi, Ti
    if memory.endswith('i') and len(memory) >= 3:
        suffix = memory[-2:].lower()
        value = memory[:-2]
        suffix_map = {'ki': 'k', 'mi': 'm', 'gi': 'g', 'ti': 't'}
        if suffix in suffix_map:
            return f"{value}{suffix_map[suffix]}"
    
    # Kubernetes decimal format: K, M, G, T (single uppercase letter)
    if memory[-1] in ('K', 'M', 'G', 'T'):
        return memory.lower()
    
    # Return as-is if no conversion needed (e.g., pure number)
    return memory


class PersistentContainerManager:
    """Manager for persistent (long-running) containers"""

    def __init__(self, subprocess_module=subprocess):
        """Initialize the persistent container manager"""
        self.subprocess = subprocess_module
        self._container_cache: Dict[str, Dict[str, Any]] = {}

    def get_or_create_container(
        self,
        user_id: int,
        shell_id: int,
        shell_config: Dict[str, Any],
        git_config: Dict[str, Any],
        executor_image: str,
    ) -> Dict[str, Any]:
        """
        Get existing container or create a new one for persistent workspace.

        Args:
            user_id: User ID
            shell_id: Shell ID
            shell_config: Shell configuration including resources
            git_config: Git repository configuration
            executor_image: Default executor image

        Returns:
            Container info dict with container_id, access_url, status
        """
        container_name = self._generate_container_name(user_id, shell_id)

        # Check if container already exists and is running
        container_status = self._get_container_status(container_name)

        if container_status == "running":
            logger.info(f"Reusing existing container: {container_name}")
            port = self._get_container_port(container_name)
            return {
                "status": "running",
                "container_id": container_name,
                "access_url": f"http://localhost:{port}" if port else None,
                "port": port,
                "reused": True,
            }

        if container_status in ("exited", "stopped"):
            logger.info(f"Restarting stopped container: {container_name}")
            return self.restart_container(container_name)

        # Create new container
        logger.info(f"Creating new persistent container: {container_name}")
        return self._create_container(
            container_name=container_name,
            user_id=user_id,
            shell_id=shell_id,
            shell_config=shell_config,
            git_config=git_config,
            executor_image=executor_image,
        )

    def _generate_container_name(self, user_id: int, shell_id: int) -> str:
        """Generate unique container name for persistent workspace"""
        return f"wegent-persistent-{user_id}-{shell_id}"

    def _get_container_status(self, container_name: str) -> Optional[str]:
        """Get container status (running, exited, stopped, or None if not exists)"""
        try:
            result = self.subprocess.run(
                ["docker", "inspect", "--format", "{{.State.Status}}", container_name],
                capture_output=True,
                text=True,
                timeout=10,
            )
            if result.returncode == 0:
                return result.stdout.strip()
            return None
        except Exception as e:
            logger.debug(f"Error checking container status: {e}")
            return None

    def _get_container_port(self, container_name: str) -> Optional[int]:
        """Get the host port for a container"""
        try:
            result = self.subprocess.run(
                [
                    "docker",
                    "inspect",
                    "--format",
                    "{{range $p, $conf := .NetworkSettings.Ports}}{{if $conf}}{{(index $conf 0).HostPort}}{{end}}{{end}}",
                    container_name,
                ],
                capture_output=True,
                text=True,
                timeout=10,
            )
            if result.returncode == 0 and result.stdout.strip():
                return int(result.stdout.strip())
            return None
        except Exception as e:
            logger.debug(f"Error getting container port: {e}")
            return None

    def _create_container(
        self,
        container_name: str,
        user_id: int,
        shell_id: int,
        shell_config: Dict[str, Any],
        git_config: Dict[str, Any],
        executor_image: str,
    ) -> Dict[str, Any]:
        """Create a new persistent container"""
        from executor_manager.executors.docker.binary_extractor import EXECUTOR_BINARY_VOLUME

        # Extract resource configuration
        resources = shell_config.get("resources", {})
        cpu_limit = resources.get("cpu", os.getenv("DEFAULT_CPU_LIMIT", "2"))
        memory_limit = resources.get("memory", os.getenv("DEFAULT_MEMORY_LIMIT", "4Gi"))

        # Get base image
        base_image = shell_config.get("baseImage") or executor_image

        # Find available port
        port = find_available_port()

        # Build docker command
        cmd = [
            "docker",
            "run",
            "-d",  # Detached mode
            "--name", container_name,
            # Labels for management
            "--label", f"owner={CONTAINER_OWNER}",
            "--label", f"user_id={user_id}",
            "--label", f"shell_id={shell_id}",
            "--label", "workspace_type=persistent",
            "--label", f"aigc.weibo.com/persistent=true",
            # Resource limits
            "--cpus", str(cpu_limit),
            "--memory", convert_memory_format(memory_limit),
            # Environment
            "-e", f"TZ={DEFAULT_TIMEZONE}",
            "-e", f"LANG={DEFAULT_LOCALE}",
            "-e", f"EXECUTOR_ENV={EXECUTOR_ENV}",
            "-e", f"PORT={port}",
            "-e", "PERSISTENT_MODE=true",
            # Mounts
            "-v", f"{DOCKER_SOCKET_PATH}:{DOCKER_SOCKET_PATH}",
        ]

        # Add workspace mount
        executor_workspace = os.getenv("EXECUTOR_WORKSPACE", "")
        if executor_workspace:
            cmd.extend(["-v", f"{executor_workspace}:{WORKSPACE_MOUNT_PATH}"])

        # Add network configuration
        network = os.getenv("NETWORK", "")
        if network:
            cmd.extend(["--network", network])

        # Add port mapping
        cmd.extend(["-p", f"{port}:{port}"])

        # Add TASK_API_DOMAIN for backend communication
        task_api_domain = os.getenv("TASK_API_DOMAIN", "")
        if task_api_domain:
            cmd.extend(["-e", f"TASK_API_DOMAIN={task_api_domain}"])

        # Add CALLBACK_URL for executor to report progress
        callback_url = build_callback_url({})
        if callback_url:
            cmd.extend(["-e", f"CALLBACK_URL={callback_url}"])

        # If using custom base_image, mount executor binary
        if base_image and base_image != executor_image:
            cmd.extend([
                "-v", f"{EXECUTOR_BINARY_VOLUME}:/app:ro",
                "--entrypoint", "/app/executor",
            ])
            final_image = base_image
        else:
            final_image = executor_image

        cmd.append(final_image)

        try:
            logger.info(f"Starting persistent container: {container_name}")
            result = self.subprocess.run(cmd, check=True, capture_output=True, text=True)
            container_id = result.stdout.strip()

            # Clone repository if git config provided
            if git_config and git_config.get("repo_url"):
                self._setup_workspace(container_name, git_config)

            logger.info(f"Created persistent container {container_name} with ID {container_id}")

            return {
                "status": "running",
                "container_id": container_name,
                "docker_id": container_id,
                "access_url": f"http://localhost:{port}",
                "port": port,
                "reused": False,
            }

        except subprocess.CalledProcessError as e:
            logger.error(f"Failed to create persistent container: {e.stderr}")
            return {
                "status": "error",
                "error_message": f"Failed to create container: {e.stderr}",
            }
        except Exception as e:
            logger.error(f"Error creating persistent container: {e}")
            return {
                "status": "error",
                "error_message": str(e),
            }

    def _setup_workspace(self, container_name: str, git_config: Dict[str, Any]) -> bool:
        """
        Setup workspace in container: create workspace directories following the new structure.

        The new workspace structure is:
        /workspace/
        ├── repos/      - Bare Git repositories
        ├── features/   - Feature directories with worktrees
        ├── tasks/      - Task temporary directories
        └── shared/     - Shared resources

        Note: The actual code cloning is handled by the executor's WorkspaceSetup
        when the task is executed. This method only creates the directory structure.

        Args:
            container_name: Name of the container
            git_config: Git configuration with repo_url, branch, git_token, etc.

        Returns:
            True if setup successful, False otherwise
        """
        try:
            # Create workspace directories following the new structure design
            # These directories match executor/config/config.py definitions
            self.subprocess.run(
                [
                    "docker", "exec", container_name,
                    "mkdir", "-p",
                    "/workspace/repos",      # Bare Git repositories
                    "/workspace/features",   # Feature directories with worktrees
                    "/workspace/tasks",      # Task temporary directories
                    "/workspace/shared"      # Shared resources
                ],
                check=True,
                capture_output=True,
                timeout=30,
            )

            logger.info(f"Workspace directories created for container {container_name}")
            return True

        except subprocess.TimeoutExpired:
            logger.error(f"Timeout setting up workspace for {container_name}")
            return False
        except Exception as e:
            logger.error(f"Error setting up workspace: {e}")
            return False

    def _build_authenticated_url(self, repo_url: str, git_config: Dict[str, Any]) -> str:
        """
        Build authenticated git URL with token if available.

        Args:
            repo_url: Original repository URL
            git_config: Git configuration containing git_token and git_login

        Returns:
            Authenticated URL or original URL if no token
        """
        git_token = git_config.get("git_token")
        if not git_token:
            return repo_url

        # Decrypt git_token if it's encrypted
        try:
            from shared.utils.crypto import decrypt_git_token, is_token_encrypted
            if is_token_encrypted(git_token):
                decrypted_token = decrypt_git_token(git_token)
                if decrypted_token:
                    git_token = decrypted_token
                    logger.debug("Successfully decrypted git token")
        except Exception as e:
            logger.warning(f"Failed to decrypt git token: {e}, using as-is")

        # Parse URL and inject credentials
        # Supports: https://domain/path.git -> https://user:token@domain/path.git
        if repo_url.startswith("https://"):
            git_login = git_config.get("git_login", "oauth2")
            # Insert credentials after https://
            return repo_url.replace("https://", f"https://{git_login}:{git_token}@", 1)
        elif repo_url.startswith("http://"):
            git_login = git_config.get("git_login", "oauth2")
            return repo_url.replace("http://", f"http://{git_login}:{git_token}@", 1)
        
        # For other URL formats (ssh, etc.), return as-is
        return repo_url

    def restart_container(self, container_name: str) -> Dict[str, Any]:
        """Restart a stopped container"""
        try:
            self.subprocess.run(
                ["docker", "start", container_name],
                check=True,
                capture_output=True,
                timeout=30,
            )

            # Wait for container to be ready
            time.sleep(2)

            port = self._get_container_port(container_name)
            status = self._get_container_status(container_name)

            logger.info(f"Restarted container {container_name}, status: {status}")

            return {
                "status": status or "running",
                "container_id": container_name,
                "access_url": f"http://localhost:{port}" if port else None,
                "port": port,
                "reused": True,
            }

        except subprocess.CalledProcessError as e:
            logger.error(f"Failed to restart container {container_name}: {e.stderr}")
            return {
                "status": "error",
                "error_message": f"Failed to restart container: {e.stderr}",
            }
        except Exception as e:
            logger.error(f"Error restarting container: {e}")
            return {
                "status": "error",
                "error_message": str(e),
            }

    def stop_container(self, container_name: str) -> Dict[str, Any]:
        """Stop a running container"""
        try:
            self.subprocess.run(
                ["docker", "stop", container_name],
                check=True,
                capture_output=True,
                timeout=30,
            )
            logger.info(f"Stopped container {container_name}")
            return {"status": "success", "message": f"Container {container_name} stopped"}
        except subprocess.CalledProcessError as e:
            logger.error(f"Failed to stop container {container_name}: {e.stderr}")
            return {"status": "error", "error_message": str(e.stderr)}
        except Exception as e:
            logger.error(f"Error stopping container: {e}")
            return {"status": "error", "error_message": str(e)}

    def delete_container(self, container_name: str) -> Dict[str, Any]:
        """Delete a container (stop and remove)"""
        return delete_container(container_name)

    def get_container_info(self, user_id: int, shell_id: int) -> Optional[Dict[str, Any]]:
        """Get information about a persistent container"""
        container_name = self._generate_container_name(user_id, shell_id)
        status = self._get_container_status(container_name)

        if not status:
            return None

        port = self._get_container_port(container_name)

        return {
            "container_id": container_name,
            "status": status,
            "access_url": f"http://localhost:{port}" if port else None,
        }

    def list_persistent_containers(self, user_id: Optional[int] = None) -> Dict[str, Any]:
        """List all persistent containers, optionally filtered by user"""
        try:
            filter_args = ["--filter", f"label=owner={CONTAINER_OWNER}", "--filter", "label=workspace_type=persistent"]

            if user_id is not None:
                filter_args.extend(["--filter", f"label=user_id={user_id}"])

            result = self.subprocess.run(
                ["docker", "ps", "-a", "--format", "{{.Names}}\t{{.Status}}\t{{.Labels}}"] + filter_args,
                capture_output=True,
                text=True,
                timeout=30,
            )

            containers = []
            if result.returncode == 0 and result.stdout.strip():
                for line in result.stdout.strip().split("\n"):
                    parts = line.split("\t")
                    if len(parts) >= 2:
                        containers.append({
                            "name": parts[0],
                            "status": parts[1],
                        })

            return {
                "status": "success",
                "containers": containers,
                "count": len(containers),
            }

        except Exception as e:
            logger.error(f"Error listing persistent containers: {e}")
            return {
                "status": "error",
                "error_message": str(e),
                "containers": [],
                "count": 0,
            }
