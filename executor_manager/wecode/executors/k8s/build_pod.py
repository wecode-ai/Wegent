# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import json
import os

import yaml
from jinja2 import Environment, FileSystemLoader

from executor_manager.config.config import EXECUTOR_ENV
from executor_manager.wecode.config.config import (
    EXECUTOR_CUSTOM_CONFIG,
    REPO_PROXY_CONFIG,
)
from executor_manager.wecode.executors.k8s.binary_extractor import (
    get_init_container_config,
    should_use_init_container,
)
from shared.telemetry.config import get_otel_config

executor_manager_host = os.getenv(
    "EXECUTOR_MANAGER_URL", "http://wegent-executor-manager-web.wb-plat-ide:8080"
)
callback_url = executor_manager_host + "/executor-manager/callback"


def to_nice_yaml(value, indent=2):
    """
    Convert value to YAML format.
    Note: We preserve the 'name' field for initContainers.
    """
    return yaml.dump(
        value, default_flow_style=False, indent=indent, sort_keys=False
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
    template = env.get_template("pod_template.yaml")

    repo_proxy_config = {}
    metadata = task.get("metadata", {})
    if "github.com" in metadata.get("git_domain", ""):
        repo_proxy_config = REPO_PROXY_CONFIG

    volumes_info = build_pod_volumes(task)

    # Check if we should use InitContainer pattern (base_image support)
    base_image = _get_base_image_from_task(task)
    use_init_container = should_use_init_container(base_image)

    # Check task type for sandbox/subagent support
    task_type = task.get("type", "online")
    is_sandbox = task_type == "sandbox"

    # Get sandbox metadata for e2b protocol support
    sandbox_metadata = task.get("sandbox_metadata", {})
    sandbox_id = sandbox_metadata.get("sandbox_id")

    # Compute heartbeat ID and type for OOM detection
    # - Sandbox tasks: use sandbox_id as identifier
    # - Regular tasks: use task_id as identifier
    # - Validation tasks: skip (short-lived)
    if task_type == "validation":
        heartbeat_id = None
        heartbeat_type = None
    elif is_sandbox and sandbox_id:
        heartbeat_id = sandbox_id
        heartbeat_type = "sandbox"
    else:
        # Regular online tasks use task_id
        heartbeat_id = str(task_id) if task_id else None
        heartbeat_type = "task" if heartbeat_id else None

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

    # Get OpenTelemetry configuration
    otel_config = get_otel_config()

    # Prepare template parameters
    template_params = {
        "username": username,
        "executor_name": executor_name,
        "namespace": namespace,
        "task_str": json.dumps(task),
        "image": container_image,
        "auth_token": task.get("auth_token"),
        "task_id": task_id,
        "task_type": task.get("type", "online"),
        "mode": mode,
        "executor_env": EXECUTOR_ENV,
        "repo_proxy_config": repo_proxy_config,
        "executor_custom_config": EXECUTOR_CUSTOM_CONFIG,
        "volumes": volumes_info.get("volumes", []),
        "volume_mounts": volumes_info.get("volume_mounts", []),
        "init_container": init_container,
        "container_entrypoint": container_entrypoint,
        "use_base_image": use_init_container,
        "task_api_domain": os.getenv(
            "TASK_API_DOMAIN", "http://wegent-backend-web.wb-plat-ide:8080"
        ),
        "callback_url": callback_url,
        # Sandbox/Subagent support for e2b protocol
        "is_sandbox": is_sandbox,
        "sandbox_id": sandbox_id,
        # Heartbeat monitoring for OOM detection
        "heartbeat_id": heartbeat_id,
        "heartbeat_type": heartbeat_type,
        "executor_manager_heartbeat_base_url": os.getenv(
            "EXECUTOR_MANAGER_HEARTBEAT_BASE_URL",
            "http://wegent-executor-manager-web.wb-plat-ide:8080/executor-manager",
        ),
        # OpenTelemetry configuration
        "otel_enabled": otel_config.enabled,
        "otel_service_name": "wegent-executor",
        "otel_otlp_endpoint": otel_config.otlp_endpoint,
        "otel_sampler_ratio": otel_config.sampler_ratio,
        "otel_metrics_enabled": otel_config.metrics_enabled,
        "otel_capture_request_headers": otel_config.capture_request_headers,
        "otel_capture_request_body": otel_config.capture_request_body,
        "otel_capture_response_headers": otel_config.capture_response_headers,
        "otel_capture_response_body": otel_config.capture_response_body,
        "otel_max_body_size": otel_config.max_body_size,
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
    supported_domains = [
        "git.intra.weibo.com",
        "git.staff.sina.com.cn",
        "gitlab.weibo.cn",
    ]

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
        volume_mounts.append(
            {
                "mountPath": f"/root/.ssh/{git_domain}",
                "name": "git-ssh",
                "readOnly": True,
                "subPath": git_domain,
            }
        )

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
