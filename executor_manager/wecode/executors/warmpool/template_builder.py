# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Template builder for warm pool pods.

This module builds pod configurations for warm pool by rendering the shared
pod_template.yaml with is_warm_pool=true. This ensures consistency between
direct pod creation and warm pool pod templates.
"""

import os
from typing import Any, Dict, Optional

import yaml
from jinja2 import Environment, FileSystemLoader
from shared.logger import setup_logger
from shared.telemetry.config import get_otel_config

from executor_manager.config.config import EXECUTOR_ENV
from executor_manager.wecode.config.config import (
    EXECUTOR_CUSTOM_CONFIG,
    EXECUTOR_DEFAULT_MAGE,
    K8S_NAMESPACE,
    REPO_PROXY_CONFIG,
    WARMPOOL_MAX_IDLE_TIME,
    WARMPOOL_MAX_REPLICAS,
    WARMPOOL_MIN_REPLICAS,
    WARMPOOL_NAME,
    WARMPOOL_SIZE,
    WARMPOOL_TEMPLATE_NAME,
)
from executor_manager.wecode.executors.warmpool.constants import (
    LABEL_EXECUTOR,
    LABEL_EXECUTOR_VALUE,
)

logger = setup_logger(__name__)

# Path to the shared pod template
POD_TEMPLATE_DIR = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "k8s"
)


def to_nice_yaml(value, indent=2):
    """Convert value to YAML format."""
    return yaml.dump(
        value, default_flow_style=False, indent=indent, sort_keys=False
    ).rstrip()


def build_warm_pool_pod_config(
    executor_name: str = "warmpool-standby",
    executor_image: Optional[str] = None,
    namespace: Optional[str] = None,
    pool_state: str = "standby",
) -> Dict[str, Any]:
    """
    Build a warm pool pod configuration by rendering pod_template.yaml.

    Args:
        executor_name: Name for the warm pool pod
        executor_image: Executor container image
        namespace: Kubernetes namespace
        pool_state: Pool state (standby/bound)

    Returns:
        Pod configuration dict
    """
    image = executor_image or EXECUTOR_DEFAULT_MAGE
    ns = namespace or K8S_NAMESPACE

    # Setup Jinja2 environment
    env = Environment(loader=FileSystemLoader(POD_TEMPLATE_DIR))
    env.filters["to_nice_yaml"] = to_nice_yaml
    env.filters["tojson"] = lambda x: yaml.dump(x, default_flow_style=True)

    # Load the template
    template = env.get_template("pod_template.yaml")

    # Get OpenTelemetry configuration
    otel_config = get_otel_config()

    executor_manager_host = os.getenv(
        "EXECUTOR_MANAGER_URL",
        "http://wegent-executor-manager-web.wb-plat-ide:8080"
    )
    callback_url = executor_manager_host + "/executor-manager/callback"

    # Build template parameters for warm pool mode
    template_params = {
        "username": "warmpool",
        "executor_name": executor_name,
        "namespace": ns,
        "task_str": "{}",
        "image": image,
        "auth_token": "",  # Will be set via label at bind time
        "task_id": "",  # Will be set via label at bind time
        "task_type": "online",
        "mode": "default",
        "executor_env": EXECUTOR_ENV,
        "repo_proxy_config": REPO_PROXY_CONFIG,
        "executor_custom_config": EXECUTOR_CUSTOM_CONFIG,
        "volumes": [],
        "volume_mounts": [],
        "init_container": None,
        "container_entrypoint": None,
        "use_base_image": False,
        "task_api_domain": os.getenv(
            "TASK_API_DOMAIN", "http://wegent-backend-web.wb-plat-ide:8080"
        ),
        "callback_url": callback_url,
        "is_sandbox": False,
        "sandbox_id": None,
        "heartbeat_id": "",  # Will be set via label at bind time
        "heartbeat_type": None,
        "executor_manager_heartbeat_base_url": os.getenv(
            "EXECUTOR_MANAGER_HEARTBEAT_BASE_URL",
            "http://wegent-executor-manager-web.wb-plat-ide:8080/executor-manager",
        ),
        # Warm pool specific
        "is_warm_pool": True,
        "pool_state": pool_state,
        # OpenTelemetry
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

    # Parse YAML to dictionary
    pod_config = yaml.safe_load(rendered_yaml)

    return pod_config


def build_sandbox_template_cr(
    name: Optional[str] = None,
    executor_image: Optional[str] = None,
    namespace: Optional[str] = None,
    labels: Optional[Dict[str, str]] = None,
) -> Dict[str, Any]:
    """
    Build a SandboxTemplate CR object for agent-sandbox.

    Args:
        name: Template name (defaults to WARMPOOL_TEMPLATE_NAME)
        executor_image: Executor container image
        namespace: Kubernetes namespace
        labels: Additional labels

    Returns:
        SandboxTemplate CR object
    """
    template_name = name or WARMPOOL_TEMPLATE_NAME
    ns = namespace or K8S_NAMESPACE

    # Build pod config for warm pool
    pod_config = build_warm_pool_pod_config(
        executor_name="warmpool-standby",
        executor_image=executor_image,
        namespace=namespace,
    )

    # Extract podTemplate from pod config
    pod_template = {
        "metadata": pod_config.get("metadata", {}),
        "spec": pod_config.get("spec", {}),
    }

    template_labels = {
        "app": "wegent-executor",
        LABEL_EXECUTOR: LABEL_EXECUTOR_VALUE,
    }
    if labels:
        template_labels.update(labels)

    return {
        "apiVersion": "extensions.agents.x-k8s.io/v1alpha1",
        "kind": "SandboxTemplate",
        "metadata": {
            "name": template_name,
            "namespace": ns,
            "labels": template_labels,
        },
        "spec": {
            "podTemplate": pod_template,
        },
    }


def build_sandbox_warmpool_cr(
    name: Optional[str] = None,
    template_name: Optional[str] = None,
    replicas: Optional[int] = None,
    min_replicas: Optional[int] = None,
    max_replicas: Optional[int] = None,
    max_idle_time: Optional[str] = None,
    namespace: Optional[str] = None,
    labels: Optional[Dict[str, str]] = None,
) -> Dict[str, Any]:
    """
    Build a SandboxWarmPool CR object for agent-sandbox.

    Args:
        name: Warm pool name (defaults to WARMPOOL_NAME)
        template_name: SandboxTemplate reference (defaults to WARMPOOL_TEMPLATE_NAME)
        replicas: Number of warm pods (defaults to WARMPOOL_SIZE)
        min_replicas: Minimum replicas (defaults to WARMPOOL_MIN_REPLICAS)
        max_replicas: Maximum replicas (defaults to WARMPOOL_MAX_REPLICAS)
        max_idle_time: Max idle time (defaults to WARMPOOL_MAX_IDLE_TIME)
        namespace: Kubernetes namespace
        labels: Additional labels

    Returns:
        SandboxWarmPool CR object
    """
    warmpool_name = name or WARMPOOL_NAME
    tpl_name = template_name or WARMPOOL_TEMPLATE_NAME
    ns = namespace or K8S_NAMESPACE

    warmpool_labels = {
        "app": "wegent-executor",
        LABEL_EXECUTOR: LABEL_EXECUTOR_VALUE,
    }
    if labels:
        warmpool_labels.update(labels)

    return {
        "apiVersion": "extensions.agents.x-k8s.io/v1alpha1",
        "kind": "SandboxWarmPool",
        "metadata": {
            "name": warmpool_name,
            "namespace": ns,
            "labels": warmpool_labels,
        },
        "spec": {
            "sandboxTemplateRef": {
                "name": tpl_name,
            },
            "replicas": replicas or WARMPOOL_SIZE,
            "scaling": {
                "minReplicas": min_replicas or WARMPOOL_MIN_REPLICAS,
                "maxReplicas": max_replicas or WARMPOOL_MAX_REPLICAS,
            },
            "podLifecycle": {
                "maxIdleTime": max_idle_time or WARMPOOL_MAX_IDLE_TIME,
            },
        },
    }


def export_sandbox_template_yaml(
    output_path: str,
    executor_image: Optional[str] = None,
    namespace: Optional[str] = None,
) -> None:
    """
    Export SandboxTemplate CR to a YAML file.

    Args:
        output_path: Output file path
        executor_image: Executor container image
        namespace: Kubernetes namespace
    """
    template_cr = build_sandbox_template_cr(
        executor_image=executor_image,
        namespace=namespace,
    )

    with open(output_path, "w") as f:
        yaml.dump(template_cr, f, default_flow_style=False, sort_keys=False)

    logger.info(f"Exported SandboxTemplate to {output_path}")


def export_sandbox_warmpool_yaml(
    output_path: str,
    namespace: Optional[str] = None,
) -> None:
    """
    Export SandboxWarmPool CR to a YAML file.

    Args:
        output_path: Output file path
        namespace: Kubernetes namespace
    """
    warmpool_cr = build_sandbox_warmpool_cr(namespace=namespace)

    with open(output_path, "w") as f:
        yaml.dump(warmpool_cr, f, default_flow_style=False, sort_keys=False)

    logger.info(f"Exported SandboxWarmPool to {output_path}")
