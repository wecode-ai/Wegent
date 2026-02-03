# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Kubernetes Custom Resource client for agent-sandbox CRDs.

Provides CRUD operations for:
- SandboxClaim (sandboxclaims.extensions.agents.x-k8s.io) - User creates to claim pods
- Sandbox (sandboxes.agents.x-k8s.io) - Created by controller, used for status query
- SandboxTemplate (sandboxtemplates.extensions.agents.x-k8s.io) - Pod templates
- SandboxWarmPool (sandboxwarmpools.extensions.agents.x-k8s.io) - Warm pool configuration
"""

import json
from typing import Any, Dict, List, Optional

from kubernetes import client
from kubernetes.client.rest import ApiException
from shared.logger import setup_logger

from executor_manager.wecode.executors.warmpool.constants import (
    ANNOTATION_TASK_INFO,
    SANDBOX_API_GROUP,
    SANDBOX_API_VERSION,
    SANDBOX_CLAIM_API_GROUP,
    SANDBOX_CLAIM_API_VERSION,
    SANDBOX_CLAIM_PLURAL,
    SANDBOX_PLURAL,
    SANDBOX_TEMPLATE_API_GROUP,
    SANDBOX_TEMPLATE_API_VERSION,
    SANDBOX_TEMPLATE_PLURAL,
    SANDBOX_WARMPOOL_API_GROUP,
    SANDBOX_WARMPOOL_API_VERSION,
    SANDBOX_WARMPOOL_PLURAL,
)

logger = setup_logger(__name__)


class WarmPoolClient:
    """
    Client for interacting with agent-sandbox CRDs.

    Provides operations for managing SandboxClaims, Sandboxes, SandboxTemplates,
    and SandboxWarmPools in Kubernetes.
    """

    def __init__(self, api_client: client.ApiClient, namespace: str):
        """
        Initialize the warm pool client.

        Args:
            api_client: Kubernetes API client
            namespace: Kubernetes namespace
        """
        self.api_client = api_client
        self.namespace = namespace
        self.custom_api = client.CustomObjectsApi(api_client)
        self.core_api = client.CoreV1Api(api_client)

    # ==================== SandboxClaim Operations ====================

    def create_sandbox_claim(
        self,
        name: str,
        template_name: str,
        labels: Dict[str, str],
        annotations: Dict[str, str],
        task_info: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """
        Create a SandboxClaim CR to claim a pod from the warm pool.

        Args:
            name: SandboxClaim name (executor_name)
            template_name: Reference to SandboxTemplate
            labels: Labels to apply to the sandbox/pod
            annotations: Annotations to apply to the sandbox/pod
            task_info: Task information to inject via annotation

        Returns:
            Created SandboxClaim object
        """
        # Inject task_info into annotations for DownwardAPI
        if task_info:
            annotations[ANNOTATION_TASK_INFO] = json.dumps(task_info)

        claim_body = {
            "apiVersion": f"{SANDBOX_CLAIM_API_GROUP}/{SANDBOX_CLAIM_API_VERSION}",
            "kind": "SandboxClaim",
            "metadata": {
                "name": name,
                "namespace": self.namespace,
                "labels": labels,
                "annotations": annotations,
            },
            "spec": {
                "sandboxTemplateRef": {
                    "name": template_name,
                },
            },
        }

        logger.info(f"Creating SandboxClaim '{name}' with template '{template_name}'")

        return self.custom_api.create_namespaced_custom_object(
            group=SANDBOX_CLAIM_API_GROUP,
            version=SANDBOX_CLAIM_API_VERSION,
            namespace=self.namespace,
            plural=SANDBOX_CLAIM_PLURAL,
            body=claim_body,
        )

    def get_sandbox_claim(self, name: str) -> Optional[Dict[str, Any]]:
        """
        Get a SandboxClaim by name.

        Args:
            name: SandboxClaim name

        Returns:
            SandboxClaim object or None if not found
        """
        try:
            return self.custom_api.get_namespaced_custom_object(
                group=SANDBOX_CLAIM_API_GROUP,
                version=SANDBOX_CLAIM_API_VERSION,
                namespace=self.namespace,
                plural=SANDBOX_CLAIM_PLURAL,
                name=name,
            )
        except ApiException as e:
            if e.status == 404:
                return None
            raise

    def delete_sandbox_claim(self, name: str) -> Dict[str, Any]:
        """
        Delete a SandboxClaim.

        Args:
            name: SandboxClaim name

        Returns:
            Deletion result
        """
        logger.info(f"Deleting SandboxClaim '{name}'")

        return self.custom_api.delete_namespaced_custom_object(
            group=SANDBOX_CLAIM_API_GROUP,
            version=SANDBOX_CLAIM_API_VERSION,
            namespace=self.namespace,
            plural=SANDBOX_CLAIM_PLURAL,
            name=name,
        )

    def list_sandbox_claims(
        self, label_selector: Optional[str] = None
    ) -> List[Dict[str, Any]]:
        """
        List SandboxClaims with optional label selector.

        Args:
            label_selector: Kubernetes label selector string

        Returns:
            List of SandboxClaim objects
        """
        kwargs = {
            "group": SANDBOX_CLAIM_API_GROUP,
            "version": SANDBOX_CLAIM_API_VERSION,
            "namespace": self.namespace,
            "plural": SANDBOX_CLAIM_PLURAL,
        }
        if label_selector:
            kwargs["label_selector"] = label_selector

        result = self.custom_api.list_namespaced_custom_object(**kwargs)
        return result.get("items", [])

    def patch_sandbox_claim(
        self,
        name: str,
        labels: Optional[Dict[str, str]] = None,
        annotations: Optional[Dict[str, str]] = None,
        task_info: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """
        Patch SandboxClaim labels and annotations.

        Used to inject task-specific data after claiming from warm pool.

        Args:
            name: SandboxClaim name
            labels: Labels to merge
            annotations: Annotations to merge
            task_info: Task info to inject (will be JSON-encoded)

        Returns:
            Updated SandboxClaim object
        """
        patch_body: Dict[str, Any] = {"metadata": {}}

        if labels:
            patch_body["metadata"]["labels"] = labels

        if annotations or task_info:
            patch_body["metadata"]["annotations"] = annotations or {}
            if task_info:
                patch_body["metadata"]["annotations"][
                    ANNOTATION_TASK_INFO
                ] = json.dumps(task_info)

        logger.info(f"Patching SandboxClaim '{name}'")

        return self.custom_api.patch_namespaced_custom_object(
            group=SANDBOX_CLAIM_API_GROUP,
            version=SANDBOX_CLAIM_API_VERSION,
            namespace=self.namespace,
            plural=SANDBOX_CLAIM_PLURAL,
            name=name,
            body=patch_body,
        )

    # ==================== Sandbox Operations (Read-only for status) ====================

    def get_sandbox(self, name: str) -> Optional[Dict[str, Any]]:
        """
        Get a Sandbox by name.

        Sandbox is created by the controller when SandboxClaim is processed.
        The name is the same as the SandboxClaim name.

        Args:
            name: Sandbox name (same as SandboxClaim name)

        Returns:
            Sandbox object or None if not found
        """
        try:
            return self.custom_api.get_namespaced_custom_object(
                group=SANDBOX_API_GROUP,
                version=SANDBOX_API_VERSION,
                namespace=self.namespace,
                plural=SANDBOX_PLURAL,
                name=name,
            )
        except ApiException as e:
            if e.status == 404:
                return None
            raise

    def list_sandboxes(
        self, label_selector: Optional[str] = None
    ) -> List[Dict[str, Any]]:
        """
        List Sandboxes with optional label selector.

        Args:
            label_selector: Kubernetes label selector string

        Returns:
            List of Sandbox objects
        """
        kwargs = {
            "group": SANDBOX_API_GROUP,
            "version": SANDBOX_API_VERSION,
            "namespace": self.namespace,
            "plural": SANDBOX_PLURAL,
        }
        if label_selector:
            kwargs["label_selector"] = label_selector

        result = self.custom_api.list_namespaced_custom_object(**kwargs)
        return result.get("items", [])

    def get_sandbox_status(self, name: str) -> Dict[str, Any]:
        """
        Get Sandbox status information.

        Args:
            name: Sandbox name (same as SandboxClaim name)

        Returns:
            Status dict with phase, service info, pod info, etc.
        """
        sandbox = self.get_sandbox(name)
        if not sandbox:
            return {
                "exists": False,
                "phase": "NotFound",
                "pod_ip": None,
                "pod_name": None,
                "service": None,
                "service_fqdn": None,
            }

        status = sandbox.get("status", {})
        metadata = sandbox.get("metadata", {})
        annotations = metadata.get("annotations", {})

        # Get pod name from annotation (agents.x-k8s.io/pod-name)
        pod_name = annotations.get("agents.x-k8s.io/pod-name")

        # Determine phase from conditions
        phase = "Unknown"
        conditions = status.get("conditions", [])
        for condition in conditions:
            if condition.get("type") == "Ready":
                phase = "Running" if condition.get("status") == "True" else "Pending"
                break

        # Get pod IP - try from status first, fallback to querying Pod directly
        pod_ip = status.get("podIP")
        if not pod_ip and pod_name:
            pod_ip = self._get_pod_ip(pod_name)

        return {
            "exists": True,
            "phase": phase,
            "pod_ip": pod_ip,
            "pod_name": pod_name,
            "service": status.get("service"),
            "service_fqdn": status.get("serviceFQDN"),
            "message": status.get("message"),
        }

    def _get_pod_ip(self, pod_name: str) -> Optional[str]:
        """
        Get Pod IP by querying the Pod directly.

        Args:
            pod_name: Name of the pod

        Returns:
            Pod IP or None if not found
        """
        try:
            pod = self.core_api.read_namespaced_pod(
                name=pod_name,
                namespace=self.namespace,
            )
            return pod.status.pod_ip if pod.status else None
        except ApiException as e:
            logger.warning(f"Failed to get Pod IP for {pod_name}: {e}")
            return None

    def patch_pod_metadata(
        self,
        pod_name: str,
        labels: Optional[Dict[str, str]] = None,
        annotations: Optional[Dict[str, str]] = None,
    ) -> bool:
        """
        Patch Pod labels and annotations directly.

        Since SandboxClaim does not support passing labels/annotations to Pod,
        we need to patch Pod metadata directly after the Sandbox is created.

        Args:
            pod_name: Name of the pod
            labels: Labels to merge into the pod
            annotations: Annotations to merge into the pod

        Returns:
            True if patch succeeded, False otherwise
        """
        if not labels and not annotations:
            return True

        try:
            metadata: Dict[str, Any] = {}
            if labels:
                metadata["labels"] = labels
            if annotations:
                metadata["annotations"] = annotations

            body = {"metadata": metadata}
            logger.info(f"Patching Pod '{pod_name}' with labels={labels}, annotations={annotations}")
            self.core_api.patch_namespaced_pod(
                name=pod_name,
                namespace=self.namespace,
                body=body,
            )
            logger.info(f"Patched Pod '{pod_name}' successfully")
            return True
        except ApiException as e:
            logger.error(f"Failed to patch Pod '{pod_name}' metadata: {e}")
            return False

    def patch_pod_annotations(
        self,
        pod_name: str,
        annotations: Dict[str, str],
    ) -> bool:
        """
        Patch Pod annotations directly.

        Deprecated: Use patch_pod_metadata() instead.

        Args:
            pod_name: Name of the pod
            annotations: Annotations to merge into the pod

        Returns:
            True if patch succeeded, False otherwise
        """
        return self.patch_pod_metadata(pod_name=pod_name, annotations=annotations)

    # ==================== SandboxTemplate Operations ====================

    def create_sandbox_template(
        self,
        name: str,
        pod_template_spec: Dict[str, Any],
        labels: Optional[Dict[str, str]] = None,
    ) -> Dict[str, Any]:
        """
        Create a SandboxTemplate CR.

        Args:
            name: Template name
            pod_template_spec: Pod template specification
            labels: Optional labels

        Returns:
            Created SandboxTemplate object
        """
        template_body = {
            "apiVersion": f"{SANDBOX_TEMPLATE_API_GROUP}/{SANDBOX_TEMPLATE_API_VERSION}",
            "kind": "SandboxTemplate",
            "metadata": {
                "name": name,
                "namespace": self.namespace,
                "labels": labels or {},
            },
            "spec": {
                "podTemplate": pod_template_spec,
            },
        }

        logger.info(f"Creating SandboxTemplate '{name}'")

        return self.custom_api.create_namespaced_custom_object(
            group=SANDBOX_TEMPLATE_API_GROUP,
            version=SANDBOX_TEMPLATE_API_VERSION,
            namespace=self.namespace,
            plural=SANDBOX_TEMPLATE_PLURAL,
            body=template_body,
        )

    def get_sandbox_template(self, name: str) -> Optional[Dict[str, Any]]:
        """
        Get a SandboxTemplate by name.

        Args:
            name: Template name

        Returns:
            SandboxTemplate object or None if not found
        """
        try:
            return self.custom_api.get_namespaced_custom_object(
                group=SANDBOX_TEMPLATE_API_GROUP,
                version=SANDBOX_TEMPLATE_API_VERSION,
                namespace=self.namespace,
                plural=SANDBOX_TEMPLATE_PLURAL,
                name=name,
            )
        except ApiException as e:
            if e.status == 404:
                return None
            raise

    def delete_sandbox_template(self, name: str) -> Dict[str, Any]:
        """
        Delete a SandboxTemplate.

        Args:
            name: Template name

        Returns:
            Deletion result
        """
        logger.info(f"Deleting SandboxTemplate '{name}'")

        return self.custom_api.delete_namespaced_custom_object(
            group=SANDBOX_TEMPLATE_API_GROUP,
            version=SANDBOX_TEMPLATE_API_VERSION,
            namespace=self.namespace,
            plural=SANDBOX_TEMPLATE_PLURAL,
            name=name,
        )

    def update_sandbox_template(
        self,
        name: str,
        pod_template_spec: Dict[str, Any],
        labels: Optional[Dict[str, str]] = None,
    ) -> Dict[str, Any]:
        """
        Update (replace) a SandboxTemplate.

        Args:
            name: Template name
            pod_template_spec: New pod template specification
            labels: Optional labels

        Returns:
            Updated SandboxTemplate object
        """
        template_body = {
            "apiVersion": f"{SANDBOX_TEMPLATE_API_GROUP}/{SANDBOX_TEMPLATE_API_VERSION}",
            "kind": "SandboxTemplate",
            "metadata": {
                "name": name,
                "namespace": self.namespace,
                "labels": labels or {},
            },
            "spec": {
                "podTemplate": pod_template_spec,
            },
        }

        logger.info(f"Updating SandboxTemplate '{name}'")

        return self.custom_api.replace_namespaced_custom_object(
            group=SANDBOX_TEMPLATE_API_GROUP,
            version=SANDBOX_TEMPLATE_API_VERSION,
            namespace=self.namespace,
            plural=SANDBOX_TEMPLATE_PLURAL,
            name=name,
            body=template_body,
        )

    # ==================== SandboxWarmPool Operations ====================

    def create_sandbox_warmpool(
        self,
        name: str,
        template_name: str,
        replicas: int = 5,
        min_replicas: int = 2,
        max_replicas: int = 20,
        max_idle_time: str = "30m",
        labels: Optional[Dict[str, str]] = None,
    ) -> Dict[str, Any]:
        """
        Create a SandboxWarmPool CR.

        Args:
            name: Warm pool name
            template_name: Reference to SandboxTemplate
            replicas: Number of warm pods to maintain
            min_replicas: Minimum replicas for scaling
            max_replicas: Maximum replicas for scaling
            max_idle_time: Maximum idle time before pod recycling
            labels: Optional labels

        Returns:
            Created SandboxWarmPool object
        """
        warmpool_body = {
            "apiVersion": f"{SANDBOX_WARMPOOL_API_GROUP}/{SANDBOX_WARMPOOL_API_VERSION}",
            "kind": "SandboxWarmPool",
            "metadata": {
                "name": name,
                "namespace": self.namespace,
                "labels": labels or {},
            },
            "spec": {
                "sandboxTemplateRef": {
                    "name": template_name,
                },
                "replicas": replicas,
                "scaling": {
                    "minReplicas": min_replicas,
                    "maxReplicas": max_replicas,
                },
                "podLifecycle": {
                    "maxIdleTime": max_idle_time,
                },
            },
        }

        logger.info(
            f"Creating SandboxWarmPool '{name}' with {replicas} replicas "
            f"(min={min_replicas}, max={max_replicas})"
        )

        return self.custom_api.create_namespaced_custom_object(
            group=SANDBOX_WARMPOOL_API_GROUP,
            version=SANDBOX_WARMPOOL_API_VERSION,
            namespace=self.namespace,
            plural=SANDBOX_WARMPOOL_PLURAL,
            body=warmpool_body,
        )

    def get_sandbox_warmpool(self, name: str) -> Optional[Dict[str, Any]]:
        """
        Get a SandboxWarmPool by name.

        Args:
            name: Warm pool name

        Returns:
            SandboxWarmPool object or None if not found
        """
        try:
            return self.custom_api.get_namespaced_custom_object(
                group=SANDBOX_WARMPOOL_API_GROUP,
                version=SANDBOX_WARMPOOL_API_VERSION,
                namespace=self.namespace,
                plural=SANDBOX_WARMPOOL_PLURAL,
                name=name,
            )
        except ApiException as e:
            if e.status == 404:
                return None
            raise

    def delete_sandbox_warmpool(self, name: str) -> Dict[str, Any]:
        """
        Delete a SandboxWarmPool.

        Args:
            name: Warm pool name

        Returns:
            Deletion result
        """
        logger.info(f"Deleting SandboxWarmPool '{name}'")

        return self.custom_api.delete_namespaced_custom_object(
            group=SANDBOX_WARMPOOL_API_GROUP,
            version=SANDBOX_WARMPOOL_API_VERSION,
            namespace=self.namespace,
            plural=SANDBOX_WARMPOOL_PLURAL,
            name=name,
        )

    def get_warmpool_status(self, name: str) -> Dict[str, Any]:
        """
        Get SandboxWarmPool status information.

        Args:
            name: Warm pool name

        Returns:
            Status dict with available/total counts
        """
        warmpool = self.get_sandbox_warmpool(name)
        if not warmpool:
            return {
                "exists": False,
                "available": 0,
                "total": 0,
            }

        status = warmpool.get("status", {})
        return {
            "exists": True,
            "available": status.get("availableReplicas", 0),
            "total": status.get("replicas", 0),
            "ready": status.get("readyReplicas", 0),
        }
