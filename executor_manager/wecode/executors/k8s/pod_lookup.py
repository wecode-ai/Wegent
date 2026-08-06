# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Kubernetes Pod ownership lookup helpers."""

from typing import Any, Dict

from kubernetes.client.rest import ApiException

from executor_manager.wecode.executors.warmpool.constants import (
    LABEL_EXECUTOR,
    LABEL_EXECUTOR_VALUE,
    LABEL_PROXY_USER,
    LABEL_TASK_ID,
    LABEL_USER,
)
from shared.logger import setup_logger

logger = setup_logger(__name__)


def lookup_pod_owners_by_ip(
    core_v1: Any,
    namespace: str,
    ip_address: str,
) -> Dict[str, Any]:
    """Find Wegent executor Pods with the given Pod IP."""
    try:
        response = core_v1.list_namespaced_pod(
            namespace=namespace,
            label_selector=f"{LABEL_EXECUTOR}={LABEL_EXECUTOR_VALUE}",
            field_selector=f"status.podIP={ip_address}",
        )
    except ApiException as exc:
        logger.error("Kubernetes API error looking up Pod IP %s: %s", ip_address, exc)
        return {
            "status": "failed",
            "error_msg": f"Kubernetes API error: {exc}",
            "pods": [],
        }
    except Exception as exc:
        logger.error("Error looking up Pod IP %s: %s", ip_address, exc)
        return {"status": "failed", "error_msg": str(exc), "pods": []}

    pods = []
    for pod in response.items:
        labels = pod.metadata.labels or {}
        user_name = labels.get(LABEL_USER) or labels.get(LABEL_PROXY_USER)
        if not user_name:
            logger.warning("Ignoring ownerless Wegent Pod %s", pod.metadata.name)
            continue
        pods.append(
            {
                "pod_name": pod.metadata.name,
                "namespace": pod.metadata.namespace or namespace,
                "pod_ip": pod.status.pod_ip,
                "phase": pod.status.phase,
                "user_name": user_name,
                "task_id": labels.get(LABEL_TASK_ID),
            }
        )

    return {"status": "success", "pods": pods}
