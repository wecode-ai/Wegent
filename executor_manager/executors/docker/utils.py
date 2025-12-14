#!/usr/bin/env python

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# -*- coding: utf-8 -*-

"""
Utility functions for Docker executor
"""

import os
import re
import socket
import subprocess
from typing import Set
from urllib.parse import urlparse

from shared.logger import setup_logger
from shared.utils.ip_util import get_host_ip, is_ip_address

from executor_manager.config.config import PORT_RANGE_MAX, PORT_RANGE_MIN

logger = setup_logger(__name__)


def build_callback_url(task: dict) -> str:
    """
    Build callback URL for the executor.

    Args:
        task (dict): Task information

    Returns:
        str: Callback URL
    """
    callback_url = task.get("callback_url", os.getenv("CALLBACK_URL", ""))
    if not callback_url:
        # Get the host IP that's accessible from containers
        # 127.0.0.1 won't work for container-to-container communication
        callback_host = os.getenv("CALLBACK_HOST", get_host_ip())
        callback_port = os.getenv("CALLBACK_PORT", "8001")

        # Ensure protocol prefix for consistent parsing
        if not callback_host.startswith(("http://", "https://")):
            callback_host = f"http://{callback_host}"

        # Parse the URL components
        parsed = urlparse(callback_host)
        host = parsed.hostname
        port = parsed.port
        scheme = parsed.scheme

        # Only add port for IP addresses without port; preserve domain names as-is
        if is_ip_address(host) and not port:
            netloc = f"{host}:{callback_port}"
        else:
            netloc = parsed.netloc  # Preserve original domain/port

        callback_url = f"{scheme}://{netloc}/executor-manager/callback"

    return callback_url


def find_available_port() -> int:
    """
    Find an available port in the defined range.
    Only considers ports used by containers with label=owner=executor_manager
    and ports in use by the host system.

    Returns:
        int: An available port number

    Raises:
        RuntimeError: If no ports are available in the defined range
    """
    try:
        # Get ports used by Docker containers with specific label
        docker_used_ports = get_docker_used_ports()
        logger.info(
            "Docker ports in use by executor_manager: %s", sorted(docker_used_ports)
        )
        
        # Find first available port in range
        return _get_first_available_port(docker_used_ports)
        
    except subprocess.CalledProcessError as e:
        logger.error("Error checking Docker ports: %s", e.stderr or e)
        raise
    except Exception:
        logger.exception("Unexpected error while finding available port")
        raise


def _get_first_available_port(used_ports: Set[int]) -> int:
    """
    Find the first available port in the defined range.
    
    Args:
        used_ports: Set of ports already in use
        
    Returns:
        int: First available port
        
    Raises:
        RuntimeError: If no ports are available
    """
    for port in range(PORT_RANGE_MIN, PORT_RANGE_MAX + 1):
        if port not in used_ports:
            logger.info("Selected available port: %d", port)
            return port
            
    raise RuntimeError(
        f"No available ports in range {PORT_RANGE_MIN}-{PORT_RANGE_MAX}"
    )


def get_docker_used_ports() -> Set[int]:
    """
    Get ports used by Docker containers with owner=executor_manager label.

    Returns:
        Set[int]: Set of port numbers in use
    """
    docker_used_ports = set()
    cmd = [
        "docker",
        "ps",
        "--filter",
        "label=owner=executor_manager",
        "--format",
        "{{.Ports}}",
    ]
    result = subprocess.run(cmd, check=True, capture_output=True, text=True)

    port_pattern = r"0\.0\.0\.0:(\d+)->.*?/tcp"
    for line in result.stdout.splitlines():
        docker_used_ports.update(
            int(p)
            for p in re.findall(port_pattern, line)
            if PORT_RANGE_MIN <= int(p) <= PORT_RANGE_MAX
        )

    return docker_used_ports


def check_container_ownership(container_name: str) -> bool:
    """
    Check if container exists and is owned by executor_manager.

    Args:
        container_name (str): Name of the container to check

    Returns:
        bool: True if container exists and is owned by executor_manager, False otherwise
    """
    try:
        check_cmd = [
            "docker",
            "ps",
            "-a",
            "--filter",
            f"name={container_name}",
            "--filter",
            "label=owner=executor_manager",
            "--format",
            "{{.Names}}",
        ]
        check_result = subprocess.run(
            check_cmd, check=True, capture_output=True, text=True
        )
        return container_name in check_result.stdout
    except subprocess.CalledProcessError as e:
        logger.error(f"Error checking container ownership: {e.stderr}")
        return False
    except Exception as e:
        logger.error(f"Unexpected error checking container ownership: {e}")
        return False


def delete_container(container_name: str) -> dict:
    """
    Stop and remove a Docker container.

    Args:
        container_name (str): Name of the container to delete

    Returns:
        dict: Result with status and optional error message
    """
    try:
        # Stop and remove container in one command
        cmd = f"docker stop {container_name} && docker rm {container_name}"
        subprocess.run(cmd, shell=True, check=True, capture_output=True)
        logger.info(f"Deleted Docker container '{container_name}'")
        return {"status": "success"}
    except subprocess.CalledProcessError as e:
        logger.error(f"Docker error deleting container '{container_name}': {e.stderr}")
        return {"status": "failed", "error_msg": f"Docker error: {e.stderr}"}
    except Exception as e:
        logger.error(f"Error deleting Docker container '{container_name}': {e}")
        return {"status": "failed", "error_msg": f"Error: {e}"}


def _build_docker_ps_command(label_selector: str = None) -> list:
    """
    Build docker ps command with appropriate filters.
    
    Args:
        label_selector (str, optional): Additional label selector
        
    Returns:
        list: Command arguments list
    """
    cmd = ["docker", "ps", "--filter", "label=owner=executor_manager"]
    
    if label_selector:
        cmd.extend(["--filter", f"label={label_selector}"])
        
    cmd.extend(["--format", "{{.Names}}"])
    return cmd


def count_running_containers(label_selector: str = None) -> dict:
    """
    Count running Docker containers with owner=executor_manager label.

    Args:
        label_selector (str, optional): Additional label selector for filtering

    Returns:
        dict: Result with status, count and optional error message
    """
    try:
        cmd = _build_docker_ps_command(label_selector)
        result = subprocess.run(cmd, check=True, capture_output=True, text=True)
        
        # Count non-empty lines in output
        container_count = sum(1 for line in result.stdout.split("\n") if line.strip())
        
        logger.info(f"Found {container_count} running containers with owner=executor_manager")
        return {"status": "success", "count": container_count}
        
    except Exception as e:
        error_msg = getattr(e, 'stderr', str(e))
        logger.error(f"Error listing Docker containers: {error_msg}")
        return {"status": "failed", "error_msg": f"Error: {error_msg}", "count": 0}


def get_running_task_details(label_selector: str = None) -> dict:
    """
    Get detailed information about running tasks from Docker containers.
    
    This function retrieves task_id, subtask_id, and subtask_next_id from
    running containers to determine which tasks are currently executing.

    Args:
        label_selector (str, optional): Additional label selector for filtering

    Returns:
        dict: Result with status, task_details and optional error message
    """
    try:
        # Base command with owner filter
        cmd = ["docker", "ps", "--filter", "label=owner=executor_manager"]
        
        # Add additional label selector if provided
        if label_selector:
            cmd.extend(["--filter", f"label={label_selector}"])
            
        # Format to get task_id, subtask_id, subtask_next_id and container name
        # Using go template formatting to get multiple fields
        cmd.extend([
            "--format",
            "{{.Label \"task_id\"}}|{{.Label \"subtask_id\"}}|{{.Label \"subtask_next_id\"}}|{{.Label \"aigc.weibo.com/task-type\"}}|{{.Names}}"
        ])
        
        result = subprocess.run(cmd, check=True, capture_output=True, text=True)
        
        # Process container information
        containers = []
        task_map = {}
        
        for line in result.stdout.split("\n"):
            if not line.strip():
                continue
                
            parts = line.strip().split("|")
            
            if len(parts) >= 5:
                task_id = parts[0]
                subtask_id = parts[1]
                subtask_next_id = parts[2]
                task_type = parts[3] if parts[3] else "online"
                container_name = parts[4]
                                
                container_info = {
                    "task_id": task_id,
                    "subtask_id": subtask_id,
                    "container_name": container_name,
                    "subtask_next_id": subtask_next_id,
                    "task_type": task_type
                }
                
                containers.append(container_info)
                
                # Group by task_id
                if task_id not in task_map:
                    task_map[task_id] = []
                task_map[task_id].append(container_info)
        
        # Determine which tasks are still running
        running_task_ids = []
        for task_id, task_containers in task_map.items():
            # Check if any container for this task has an empty subtask_next_id

            has_completed = False
            has_completed = any(
                container.get("subtask_next_id") == ""
                for container in task_containers
            )
            
            if not has_completed:
                running_task_ids.append(task_id)
        
        logger.info(f"Found {len(running_task_ids)} running tasks with owner=executor_manager")
        return {
            "status": "success",
            "task_ids": running_task_ids,
            "containers": containers
        }
        
    except Exception as e:
        error_msg = getattr(e, 'stderr', str(e))
        logger.error(f"Error getting task details from Docker containers: {error_msg}")
        return {
            "status": "failed",
            "error_msg": f"Error: {error_msg}",
            "task_ids": [],
            "containers": []
        }

def get_container_ports(container_name: str) -> dict:
    """
    Get port mappings for a specific container by name.
    
    Args:
        container_name (str): Name of the container
        
    Returns:
        dict: Result with status, ports information and optional error message
    """
    try:
        # Check if container exists and is owned by executor_manager
        if not check_container_ownership(container_name):
            return {
                "status": "failed",
                "error_msg": f"Container '{container_name}' not found or not owned by executor_manager",
                "ports": []
            }
            
        # Get ports information for the specific container
        cmd = [
            "docker",
            "ps",
            "--filter",
            f"name={container_name}",
            "--format",
            "{{.Ports}}",
        ]
        result = subprocess.run(cmd, check=True, capture_output=True, text=True)
        
        # Parse port information
        ports = []
        port_pattern = r"0\.0\.0\.0:(\d+)->(\d+)/(\w+)"
        
        for line in result.stdout.splitlines():
            if line.strip():
                matches = re.findall(port_pattern, line)
                for match in matches:
                    host_port, container_port, protocol = match
                    ports.append({
                        "host_port": int(host_port),
                        "container_port": int(container_port),
                        "protocol": protocol
                    })
        
        logger.info(f"Retrieved port mappings for container '{container_name}': {ports}")
        return {
            "status": "success",
            "ports": ports
        }
        
    except subprocess.CalledProcessError as e:
        error_msg = e.stderr.decode() if hasattr(e, 'stderr') else str(e)
        logger.error(f"Docker error getting ports for container '{container_name}': {error_msg}")
        return {
            "status": "failed",
            "error_msg": f"Docker error: {error_msg}",
            "ports": []
        }
    except Exception as e:
        logger.error(f"Error getting ports for container '{container_name}': {e}")
        return {
            "status": "failed",
            "error_msg": f"Error: {e}",
            "ports": []
        }


if __name__ == "__main__":
    print(get_running_task_details())