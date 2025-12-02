# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import json
import os
import yaml
from jinja2 import Environment, FileSystemLoader

from executor_manager.config.config import EXECUTOR_ENV
from executor_manager.wecode.config.config import (
    REPO_PROXY_CONFIG
)
from executor_manager.wecode.executors.k8s.binary_extractor import (
    get_init_container_config,
    should_use_init_container
)

def to_nice_yaml(value, indent=2):
    if isinstance(value, dict) and "name" in value:
        value = {k: v for k, v in value.items() if k != "name"}
    return yaml.dump(
        value,
        default_flow_style=False,
        indent=indent,
        sort_keys=False
    ).rstrip()

def build_pod_configuration(
    username, executor_name, namespace, task, image, task_id, mode
):
    """
    Build Kubernetes pod configuration using YAML template

    Args:
        username: Username for the pod
        executor_name: Name for the Kubernetes pod
        namespace: Namespace for the pod
        task: Task information dictionary
        image: Container image to use (executor image)
        task_id: ID of the task
        mode: Team mode

    Returns:
        dict: Kubernetes pod configuration
    """
    # Get the directory where this file is located
    current_dir = os.path.dirname(os.path.abspath(__file__))

    # Setup Jinja2 environment
    env = Environment(loader=FileSystemLoader(current_dir))
    env.filters["to_nice_yaml"] = to_nice_yaml

    # Load the template
    template = env.get_template('pod_template.yaml')

    repo_proxy_config = {}
    if "github.com" in task.get("git_domain",""):
        repo_proxy_config = REPO_PROXY_CONFIG

    volumes_info = build_pod_volumes(task)

    # Check if we should use InitContainer pattern (base_image support)
    base_image = _get_base_image_from_task(task)
    use_init_container = should_use_init_container(base_image)

    # Initialize init_container and additional volume info
    init_container = None
    init_container_volume = None
    init_container_volume_mount = None
    container_image = image
    container_entrypoint = None

    if use_init_container:
        # Get InitContainer configuration
        init_config = get_init_container_config(image)
        init_container = init_config["init_container"]
        init_container_volume = init_config["volume"]
        init_container_volume_mount = init_config["volume_mount"]
        container_entrypoint = init_config["entrypoint"]

        # Use base_image as the main container image
        container_image = base_image

        # Add init_container volume to volumes_info
        if "volumes" not in volumes_info:
            volumes_info["volumes"] = []
        volumes_info["volumes"].append(init_container_volume)

        # Add init_container volume mount to volume_mounts
        if "volume_mounts" not in volumes_info:
            volumes_info["volume_mounts"] = []
        volumes_info["volume_mounts"].append(init_container_volume_mount)

    # Prepare template parameters
    template_params = {
        'username': username,
        'executor_name': executor_name,
        'namespace': namespace,
        'task_str': json.dumps(task),
        'image': container_image,
        'task_id': task_id,
        'task_type': task.get("type", "online"),
        'mode': mode,
        'executor_env': EXECUTOR_ENV,
        'repo_proxy_config': repo_proxy_config,
        'volumes': volumes_info.get("volumes", []),
        'volume_mounts': volumes_info.get("volume_mounts", []),
        'init_container': init_container,
        'container_entrypoint': container_entrypoint,
        'use_base_image': use_init_container
    }

    # Render the template
    rendered_yaml = template.render(**template_params)

    # Parse YAML back to dictionary
    pod_config = yaml.safe_load(rendered_yaml)

    return pod_config

def _get_base_image_from_task(task):
    """
    Extract custom base_image from task's bot configuration.

    Args:
        task: Task dictionary containing bot information

    Returns:
        Optional[str]: base_image if found, None otherwise
    """
    bots = task.get("bot", [])
    if bots and isinstance(bots, list) and len(bots) > 0:
        # Use the first bot's base_image if available
        first_bot = bots[0]
        if isinstance(first_bot, dict):
            return first_bot.get("base_image")
    return None

def build_pod_volumes(task):
        """
        Build Kubernetes pod volumes configuration for Git SSH access

        Args:
            task: Task dictionary containing user information

        Returns:
            dict: Volume mounts and volumes configuration
        """
        user_info = task.get("user", {})
        user_name = user_info.get("name", "").replace("_", "--")
        git_domain = user_info.get("git_domain", "")

        # Supported Git domains
        supported_domains = ["git.intra.weibo.com", "git.staff.sina.com.cn", "gitlab.weibo.cn"]

        if git_domain in supported_domains:
            # Base volume mounts (id_rsa.pub is always needed)
            volume_mounts = [
                {
                    "mountPath": "/root/.ssh/id_rsa.pub",
                    "name": "git-ssh",
                    "readOnly": True,
                    "subPath": "id_rsa.pub",
                }
            ]

            # Add domain-specific SSH config
            volume_mounts.append({
                "mountPath": f"/root/.ssh/{git_domain}",
                "name": "git-ssh",
                "readOnly": True,
                "subPath": git_domain,
            })

            return {
                "volume_mounts": volume_mounts,
                "volumes": [
                    {
                        "name": "git-ssh",
                        "secret": {
                            "defaultMode": 400,
                            "secretName": f"wecode-secret-{user_name}",
                        },
                    }
                ],
            }
        else:
            return {}

