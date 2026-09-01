# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Capability checks for running Git tasks on shared warm-pool Pods."""

import json
from typing import Any, Dict, Optional
from urllib.parse import urlparse


def runtime_ineligibility_reason(
    git_url: str,
    resource: Dict[str, Any],
    expected_image: str,
    *,
    is_template: bool,
) -> Optional[str]:
    """Validate immutable capabilities required by request-scoped Git auth."""
    if not isinstance(resource, dict):
        return "git_warmpool_capability_check_failed"

    resource_spec = resource.get("spec") or {}
    if is_template:
        pod_template = _mapping_value(resource_spec, "podTemplate", "pod_template")
        resource_spec = (
            _mapping_value(pod_template, "spec")
            if isinstance(pod_template, dict)
            else None
        ) or {}

    containers = _mapping_value(resource_spec, "containers") or []
    if not containers or not isinstance(containers[0], dict):
        return "git_warmpool_capability_check_failed"
    container = containers[0]
    if str(_mapping_value(container, "image") or "") != expected_image:
        return "git_warmpool_image_mismatch"

    if not _has_executor_crypto_secret(resource_spec, container):
        return "git_warmpool_missing_crypto_secret"

    hostname = (urlparse(git_url).hostname or "").lower()
    if hostname == "github.com" or hostname.endswith(".github.com"):
        if not _has_repo_proxy_for_domain(container, hostname):
            return "git_warmpool_missing_repo_proxy"
    return None


def serialize_k8s_resource(api_client, resource: Any) -> Dict[str, Any]:
    """Convert Kubernetes models and dynamic-resource dictionaries alike."""
    if isinstance(resource, dict):
        return resource
    serialized = api_client.sanitize_for_serialization(resource)
    return serialized if isinstance(serialized, dict) else {}


def _mapping_value(mapping: Dict[str, Any], *keys: str) -> Any:
    for key in keys:
        if key in mapping:
            return mapping[key]
    return None


def _has_executor_crypto_secret(
    pod_spec: Dict[str, Any], container: Dict[str, Any]
) -> bool:
    volume_mounts = _mapping_value(container, "volumeMounts", "volume_mounts") or []
    mount_name = next(
        (
            _mapping_value(mount, "name")
            for mount in volume_mounts
            if isinstance(mount, dict)
            and _mapping_value(mount, "mountPath", "mount_path")
            == "/etc/wegent-executor-secret"
        ),
        None,
    )
    if not mount_name:
        return False

    volumes = _mapping_value(pod_spec, "volumes") or []
    for volume in volumes:
        if not isinstance(volume, dict):
            continue
        if _mapping_value(volume, "name") != mount_name:
            continue
        secret = _mapping_value(volume, "secret") or {}
        if not isinstance(secret, dict):
            return False
        return (
            _mapping_value(secret, "secretName", "secret_name")
            == "wegent-executor-secret"
        )
    return False


def _has_repo_proxy_for_domain(container: Dict[str, Any], hostname: str) -> bool:
    env_items = _mapping_value(container, "env") or []
    raw_config = next(
        (
            _mapping_value(item, "value")
            for item in env_items
            if isinstance(item, dict)
            and _mapping_value(item, "name") == "REPO_PROXY_CONFIG"
        ),
        None,
    )
    if not isinstance(raw_config, str) or not raw_config.strip():
        return False
    try:
        proxy_config = json.loads(raw_config)
    except (TypeError, ValueError):
        return False
    if not isinstance(proxy_config, dict):
        return False

    domain_config = proxy_config.get(hostname) or proxy_config.get("*")
    if not isinstance(domain_config, dict):
        return False
    return any(
        isinstance(domain_config.get(key), str) and bool(domain_config[key].strip())
        for key in ("http.proxy", "https.proxy")
    )
