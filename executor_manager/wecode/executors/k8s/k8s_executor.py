# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import json
import os
import threading
import time
from typing import Any, Dict, Optional

import requests
from kubernetes import client, config
from kubernetes.client.rest import ApiException
from shared.logger import setup_logger
from shared.status import TaskStatus

from executor_manager.executors.base import Executor
from executor_manager.executors.docker.constants import (
    DEFAULT_API_ENDPOINT, DEFAULT_PROGRESS_COMPLETE)
from executor_manager.utils.executor_name import generate_executor_name
from executor_manager.wecode.config.config import (
    EXECUTOR_DEFAULT_MAGE, K8S_NAMESPACE, MAX_USER_TASKS,
    USER_WHITELIST_TASK_LIMIT_MAP)
from executor_manager.wecode.executors.k8s.build_pod import \
    build_pod_configuration

logger = setup_logger(__name__)

# Thread-local storage for API clients
_thread_local = threading.local()

# Global lock for configuration loading
_config_lock = threading.Lock()
_config_loaded = False


def _ensure_k8s_config_loaded() -> bool:
    """
    Ensure Kubernetes configuration is loaded (only once).
    This is thread-safe and will only load the configuration once.

    Returns:
        bool: True if configuration was loaded successfully, False otherwise
    """
    global _config_loaded

    if _config_loaded:
        return True

    with _config_lock:
        # Double-check after acquiring lock
        if _config_loaded:
            return True

        try:
            config.load_incluster_config()
            logger.info("Loaded in-cluster Kubernetes configuration")
            _config_loaded = True
            return True
        except config.ConfigException:
            try:
                config.load_kube_config()
                logger.info("Loaded kubeconfig file")
                _config_loaded = True
                return True
            except config.ConfigException as e:
                logger.error(f"Could not configure Kubernetes client: {e}")
                return False


def _get_api_client() -> Optional[client.ApiClient]:
    """
    Get a thread-local API client instance.
    Creates a new client for each thread to ensure thread safety.

    Returns:
        Optional[client.ApiClient]: API client instance or None if configuration failed
    """
    if not _ensure_k8s_config_loaded():
        return None

    # Check if this thread already has an API client
    if not hasattr(_thread_local, "api_client") or _thread_local.api_client is None:
        try:
            configuration = client.Configuration.get_default_copy()
            configuration.verify_ssl = (
                False  # ❗Only recommended for debugging or internal environments
            )
            _thread_local.api_client = client.ApiClient(configuration)
            logger.debug(
                f"Created new API client for thread {threading.current_thread().name}"
            )
        except Exception as e:
            logger.error(f"Failed to create API client: {e}")
            return None

    return _thread_local.api_client


class K8sExecutor(Executor):
    def __init__(self):
        # Ensure configuration is loaded during initialization
        if not _ensure_k8s_config_loaded():
            raise RuntimeError("Failed to configure Kubernetes client")

    def _get_core_v1_api(self) -> Optional[client.CoreV1Api]:
        """
        Get a CoreV1Api instance using thread-local API client.

        Returns:
            Optional[client.CoreV1Api]: CoreV1Api instance or None if client creation failed
        """
        api_client = _get_api_client()
        if api_client is None:
            return None
        return client.CoreV1Api(api_client)

    def submit_executor(
        self, task: Dict[str, Any], callback: Optional[callable] = None
    ) -> Dict[str, Any]:
        """
        Submit a Kubernetes pod for the given task.

        Args:
            task (Dict[str, Any]): Task information.
            callback (Optional[callable]): Optional callback function.

        Returns:
            Dict[str, Any]: Submission result.
        """

        image = task.get("executor_image", EXECUTOR_DEFAULT_MAGE)
        task_id = task.get("task_id", "-1")
        subtask_id = task.get("subtask_id", "-1")

        user_config = task.get("user") or {}
        user_name = user_config.get("name", "unknown")

        # Check task type for special handling
        task_type = task.get("type")
        is_validation_task = task_type == "validation"
        is_subagent_task = task_type == "subagent"
        is_sandbox_task = task_type == "sandbox"

        status = "success"
        progress = 30
        error_msg = ""
        callback_status = TaskStatus.RUNNING.value

        if task.get("executor_name"):
            executor_name = task.get("executor_name")
            pod_result = self.get_pods_by_executor_name(executor_name)
            pod_list = pod_result.get("pods", [])
            logger.info(pod_list)
            if len(pod_list) > 0:
                ip = pod_list[0].get("ip")
                response = self._send_task_to_container(task=task, host=ip, port=8080)
                # Check HTTP status code for success
                if response.status_code == 200:
                    # Task sent successfully to existing pod, register for heartbeat monitoring
                    # This handles re-execution cases where Redis keys were cleaned up after first completion
                    self.register_task_for_heartbeat(
                        task_id=task_id,
                        subtask_id=subtask_id,
                        executor_name=executor_name,
                        task_type=task.get("type", "online"),
                        context=f"existing executor: {executor_name}",
                    )
                else:
                    status = "failed"
                    progress = 100
                    error_msg = response.json().get("error_msg", "Request failed")
                    callback_status = TaskStatus.FAILED.value
            else:
                status = "failed"
                progress = 100
                error_msg = "Agent is deleted. Please new task and submit it again."
                callback_status = TaskStatus.FAILED.value
        else:
            # Check if pod exists by executor_name, if exists, send task directly via HTTP interface
            executor_name = None
            try:
                executor_name = generate_executor_name(task_id, subtask_id, user_name)

                user_pod_count = self.get_user_pods(user_name=user_name)
                logger.info(f"User {user_name} has {user_pod_count} pods.")
                if user_pod_count >= self.get_user_max_tasks(user_name):
                    logger.info(f"User {user_name} has reached the pod limit.")
                    status = "failed"
                    progress = 100
                    error_msg = (
                        "User has reached the task limit. Please delete history tasks."
                    )
                    callback_status = TaskStatus.FAILED.value
                else:
                    # Extract base_image from bot configuration (if available)
                    base_image = self._get_base_image_from_task(task)

                    # Log base_image usage
                    if base_image:
                        logger.info(
                            f"Using custom base image: {base_image} with InitContainer pattern"
                        )

                    # Need to mount the internal git_token to the pod via secret
                    pod = build_pod_configuration(
                        user_name,
                        executor_name,
                        K8S_NAMESPACE,
                        task,
                        image,
                        task_id,
                        task.get("mode", "default"),
                    )
                    pod_result = self._submit_kubernetes_pod(
                        pod, K8S_NAMESPACE, executor_name, task_id
                    )
                    if pod_result and pod_result.get("status") == "success":
                        # Register regular tasks to RunningTaskTracker for heartbeat monitoring
                        # This enables OOM detection for non-sandbox tasks
                        self.register_task_for_heartbeat(
                            task_id=task_id,
                            subtask_id=subtask_id,
                            executor_name=executor_name,
                            task_type=task.get("type", "online"),
                        )
                    elif not pod_result or pod_result.get("status") != "success":
                        logger.error(
                            f"Kubernetes pod creation failed for task {task_id}: {pod_result.get('error_msg', '')}"
                        )
                        status = "failed"
                        progress = 100
                        error_msg = pod_result.get(
                            "error_msg", "Kubernetes pod creation failed"
                        )
                        callback_status = TaskStatus.FAILED.value

                        # For validation tasks, report failure
                        if is_validation_task:
                            self._report_validation_failure(
                                task, "starting_container", error_msg
                            )
            except ApiException as e:
                logger.error(
                    f"Kubernetes API error creating pod for task {task_id}: {e}"
                )
                status = "failed"
                progress = 100
                error_msg = f"Kubernetes API error: {e}"
                callback_status = TaskStatus.FAILED.value

                # For validation tasks, report failure
                if is_validation_task:
                    self._report_validation_failure(
                        task, "starting_container", error_msg
                    )
            except Exception as e:
                logger.error(f"Error creating Kubernetes pod for task {task_id}: {e}")
                status = "failed"
                progress = 100
                error_msg = f"Error: {e}"
                callback_status = TaskStatus.FAILED.value

                # For validation tasks, report failure
                if is_validation_task:
                    self._report_validation_failure(
                        task, "starting_container", error_msg
                    )

        # Call callback function only for regular tasks
        # Skip callback for validation tasks and subagent tasks (they have their own callback mechanism)
        if (
            not is_validation_task
            and not is_subagent_task
            and callback
            and executor_name
        ):
            try:
                # Include result with error message for frontend display
                result_value = {"value": error_msg} if error_msg else None
                callback(
                    task_id=task_id,
                    subtask_id=subtask_id,
                    executor_name=executor_name,
                    progress=progress,
                    executor_namespace=K8S_NAMESPACE,
                    status=callback_status,
                    error_message=error_msg,
                    result=result_value,
                )
            except Exception as e:
                logger.error(f"Error in callback for task {task_id}: {e}")

        if status == "success":
            return {
                "status": "success",
                "pod_name": executor_name,
                "executor_name": executor_name,
            }
        else:
            return {
                "status": "failed",
                "error_msg": error_msg,
                "pod_name": executor_name,
                "executor_name": executor_name,
            }

    def _send_task_to_container(
        self, task: Dict[str, Any], host: str, port: int
    ) -> requests.Response:
        """Send task to container API endpoint"""
        endpoint = f"http://{host}:{port}{DEFAULT_API_ENDPOINT}"
        logger.info(f"Sending task to {endpoint}")
        return requests.post(endpoint, json=task)

    def _submit_kubernetes_pod(self, pod, namespace, pod_name, task_id):
        """
        Submit a Kubernetes pod and handle exceptions.

        Args:
            pod: Kubernetes pod spec
            namespace: Namespace to submit the pod
            pod_name: Name of the pod
            task_id: Associated task ID

        Returns:
            dict: {
                "status": "success" or "failed",
                "pod_name": pod_name,
                "k8s_pod_name": created pod name (if success),
                "error_msg": error message (if failed)
            }
        """
        core_v1 = self._get_core_v1_api()
        if core_v1 is None:
            return {
                "status": "failed",
                "pod_name": pod_name,
                "error_msg": "Failed to get Kubernetes API client",
            }

        try:
            result = core_v1.create_namespaced_pod(namespace, body=pod)
            k8s_pod_name = getattr(result.metadata, "name", None)
            logger.info(
                f"Created Kubernetes pod '{pod_name}' (k8s_pod_name='{k8s_pod_name}') for task {task_id}"
            )
            return {
                "status": "success",
                "pod_name": pod_name,
            }
        except Exception as e:
            logger.error(
                f"Failed to create Kubernetes pod '{pod_name}' for task {task_id}: {e}"
            )
            return {"status": "failed", "pod_name": pod_name, "error_msg": str(e)}

    def delete_executor(self, pod_name: str) -> Dict[str, Any]:
        try:
            core_v1 = self._get_core_v1_api()
            if core_v1 is None:
                return {
                    "status": "failed",
                    "error_msg": "Failed to get Kubernetes API client",
                }

            delete_options = client.V1DeleteOptions(propagation_policy="Background")
            core_v1.delete_namespaced_pod(
                name=pod_name, namespace=K8S_NAMESPACE, body=delete_options
            )
            logger.info(f"Deleted Kubernetes pod '{pod_name}'")
            return {"status": "success"}
        except ApiException as e:
            if e.status == 404:
                logger.warning(
                    f"Pod '{pod_name}' not found in namespace {K8S_NAMESPACE}"
                )
                return {
                    "status": "not_found",
                    "error_msg": f"Pod '{pod_name}' not found",
                }
            else:
                logger.error(f"Kubernetes API error deleting pod '{pod_name}': {e}")
                return {"status": "failed", "error_msg": f"Kubernetes API error: {e}"}
        except Exception as e:
            logger.error(f"Error deleting Kubernetes pod '{pod_name}': {e}")
            return {"status": "failed", "error_msg": f"Error: {e}"}

    def delete_executor_by_task_id(self, task_id: str) -> Dict[str, Any]:
        """Delete a Kubernetes pod by task_id label (fallback method).

        This is used when the pod name is not known or the pod was not found
        by name. It searches for pods with the matching task_id label and
        deletes them.

        Args:
            task_id: Task ID to search for

        Returns:
            Dict with status and error_msg if failed
        """
        try:
            core_v1 = self._get_core_v1_api()
            if core_v1 is None:
                return {
                    "status": "failed",
                    "error_msg": "Failed to get Kubernetes API client",
                }

            # Search for pods with the matching task_id label
            label_selector = (
                f"aigc.weibo.com/executor=wegent,"
                f"aigc.weibo.com/executor-task-id={task_id}"
            )
            pods = core_v1.list_namespaced_pod(
                namespace=K8S_NAMESPACE, label_selector=label_selector
            )

            if not pods.items:
                logger.warning(
                    f"No pod found with task_id label '{task_id}' "
                    f"in namespace {K8S_NAMESPACE}"
                )
                return {
                    "status": "not_found",
                    "error_msg": f"No pod found with task_id '{task_id}'",
                }

            delete_options = client.V1DeleteOptions(propagation_policy="Background")

            # Delete all matching pods (should typically be one)
            deleted_pods = []
            for pod in pods.items:
                pod_name = pod.metadata.name
                try:
                    core_v1.delete_namespaced_pod(
                        name=pod_name,
                        namespace=K8S_NAMESPACE,
                        body=delete_options,
                    )
                    deleted_pods.append(pod_name)
                    logger.info(
                        f"Deleted Kubernetes pod '{pod_name}' "
                        f"found by task_id label '{task_id}'"
                    )
                except ApiException as e:
                    if e.status != 404:
                        logger.error(f"Failed to delete pod '{pod_name}': {e}")

            if deleted_pods:
                return {
                    "status": "success",
                    "deleted_pods": deleted_pods,
                }
            else:
                return {
                    "status": "not_found",
                    "error_msg": f"Failed to delete any pods for task_id '{task_id}'",
                }

        except ApiException as e:
            logger.error(
                f"Kubernetes API error searching pods by task_id '{task_id}': {e}"
            )
            return {"status": "failed", "error_msg": f"Kubernetes API error: {e}"}
        except Exception as e:
            logger.error(f"Error deleting pods by task_id '{task_id}': {e}")
            return {"status": "failed", "error_msg": f"Error: {e}"}

    def get_executor_task_id(self, executor_name: str) -> Optional[str]:
        """Get task_id from pod label.

        Args:
            executor_name: Name of the pod

        Returns:
            task_id string if found, None otherwise
        """
        try:
            core_v1 = self._get_core_v1_api()
            if core_v1 is None:
                return None

            pod = core_v1.read_namespaced_pod(
                name=executor_name, namespace=K8S_NAMESPACE
            )
            if pod.metadata and pod.metadata.labels:
                return pod.metadata.labels.get("aigc.weibo.com/task-id")
            return None
        except ApiException as e:
            if e.status != 404:
                logger.warning(f"Error getting task_id for pod '{executor_name}': {e}")
            return None
        except Exception as e:
            logger.warning(f"Error getting task_id for pod '{executor_name}': {e}")
            return None

    def get_current_task_ids(
        self, label_selector: Optional[str] = None
    ) -> Dict[str, Any]:
        try:
            # If no label selector is provided, use the default label selector
            if label_selector is None:
                label_selector = "aigc.weibo.com/executor=wegent"
            else:
                label_selector = f"{label_selector},aigc.weibo.com/executor=wegent"

            core_v1 = self._get_core_v1_api()
            if core_v1 is None:
                return {
                    "status": "failed",
                    "error_msg": "Failed to get Kubernetes API client",
                    "task_ids": [],
                }

            pods = core_v1.list_namespaced_pod(
                namespace=K8S_NAMESPACE, label_selector=label_selector
            )

            task_ids = set()
            for pod in pods.items:
                # Extract task ID from pod labels using the correct label name
                if (
                    pod.metadata.labels
                    and "aigc.weibo.com/executor-task-id" in pod.metadata.labels
                ):
                    task_ids.add(pod.metadata.labels["aigc.weibo.com/executor-task-id"])
                # If no explicit task ID label exists, try to extract from pod name
                else:
                    logger.warning(f"Pod {pod.metadata.name} has no task ID label.")

            task_ids = list(task_ids)

            logger.info(
                f"Found {len(task_ids)} task IDs with label selector '{label_selector}'"
            )
            return {
                "status": "success",
                "task_ids": task_ids,
            }
        except ApiException as e:
            logger.error(f"Kubernetes API error listing pods: {e}")
            return {
                "status": "failed",
                "error_msg": f"Kubernetes API error: {e}",
                "task_ids": [],
            }
        except Exception as e:
            logger.error(f"Error listing Kubernetes pods: {e}")
            return {"status": "failed", "error_msg": f"Error: {e}", "task_ids": []}

    def get_executor_count(
        self, label_selector: Optional[str] = None
    ) -> Dict[str, Any]:
        start_time = time.time()
        try:
            core_v1 = self._get_core_v1_api()
            if core_v1 is None:
                return {
                    "status": "failed",
                    "error_msg": "Failed to get Kubernetes API client",
                    "count": 0,
                }

            # Use default label selector if not provided to only count wegent pods
            if label_selector is None:
                label_selector = "aigc.weibo.com/executor=wegent"

            # Use _preload_content=False to skip SDK deserialization of V1PodList
            # This significantly improves performance when listing many pods
            # (SDK deserialization can take 17+ seconds for 300+ pods)
            response = core_v1.list_namespaced_pod(
                namespace=K8S_NAMESPACE,
                label_selector=label_selector,
                _preload_content=False,
            )

            # Parse JSON manually to get count only
            data = json.loads(response.data.decode("utf-8"))
            pod_count = len(data.get("items", []))

            elapsed = time.time() - start_time
            logger.info(
                f"Found {pod_count} pods in namespace {K8S_NAMESPACE} "
                f"(label_selector={label_selector}, took {elapsed:.2f}s)"
            )
            return {"status": "success", "running": pod_count}
        except ApiException as e:
            logger.error(f"Kubernetes API error listing pods: {e}")
            return {
                "status": "failed",
                "error_msg": f"Kubernetes API error: {e}",
                "count": 0,
            }
        except Exception as e:
            logger.error(f"Error listing Kubernetes pods: {e}")
            return {"status": "failed", "error_msg": f"Error: {e}", "count": 0}

    def get_user_pods(self, user_name: str) -> int:
        try:
            core_v1 = self._get_core_v1_api()
            if core_v1 is None:
                logger.error("Failed to get Kubernetes API client for get_user_pods")
                return 0

            label_selector = (
                f"aigc.weibo.com/executor=wegent,aigc.weibo.com/proxy-user={user_name}"
            )
            pods = core_v1.list_namespaced_pod(
                namespace=K8S_NAMESPACE, label_selector=label_selector
            )
            return len(pods.items)
        except Exception as e:
            logger.error(f"Error listing Kubernetes pods: {e}")
        return 0

    def get_pods_by_executor_name(self, executor_name: str) -> Dict[str, Any]:
        try:
            core_v1 = self._get_core_v1_api()
            if core_v1 is None:
                return {
                    "status": "failed",
                    "error_msg": "Failed to get Kubernetes API client",
                    "pods": [],
                }

            # Query related pods directly using executor name
            label_selector = f"aigc.weibo.com/executor=wegent,app={executor_name}"
            pods = core_v1.list_namespaced_pod(
                namespace=K8S_NAMESPACE, label_selector=label_selector
            )

            pod_list = []
            for pod in pods.items:
                pod_info = {
                    "name": pod.metadata.name,
                    "ip": pod.status.pod_ip,
                    "status": pod.status.phase,
                    "creation_timestamp": pod.metadata.creation_timestamp,
                }
                pod_list.append(pod_info)
            logger.info(
                f"Found {len(pod_list)} pods for executor '{executor_name}' in namespace {K8S_NAMESPACE}"
            )
            return {"status": "success", "pods": pod_list}
        except ApiException as e:
            logger.error(
                f"Kubernetes API error listing pods for executor '{executor_name}': {e}"
            )
            return {
                "status": "failed",
                "error_msg": f"Kubernetes API error: {e}",
                "pods": [],
            }
        except Exception as e:
            logger.error(f"Error listing pods for executor '{executor_name}': {e}")
            return {"status": "failed", "error_msg": f"Error: {e}", "pods": []}

    def get_container_address(self, executor_name: str) -> Dict[str, Any]:
        """Get container base URL for sandbox proxy.

        This method is called by SandboxManager to get the address for proxying
        requests to the sandbox container.

        Args:
            executor_name: Executor/Pod name

        Returns:
            Dict with status and base_url (e.g., http://10.0.0.1:8080)
        """
        pod_result = self.get_pods_by_executor_name(executor_name)
        if pod_result.get("status") != "success":
            return {
                "status": "failed",
                "error_msg": pod_result.get("error_msg", "Failed to get pod info"),
            }

        pods = pod_result.get("pods", [])
        if not pods:
            return {
                "status": "failed",
                "error_msg": f"No pod found for executor {executor_name}",
            }

        pod = pods[0]
        pod_ip = pod.get("ip")
        pod_status = pod.get("status")

        if not pod_ip:
            return {
                "status": "failed",
                "error_msg": f"Pod {executor_name} has no IP address",
            }

        if pod_status != "Running":
            return {
                "status": "failed",
                "error_msg": f"Pod {executor_name} is not running (status: {pod_status})",
            }

        return {
            "status": "success",
            "base_url": f"http://{pod_ip}:8080",
        }

    def _extract_container_termination_info(
        self, container_statuses: Optional[list]
    ) -> tuple[bool, int]:
        """Extract OOM killed flag and exit code from container statuses.

        Checks both current state and last_state for termination info.

        Args:
            container_statuses: List of container statuses from pod.status

        Returns:
            Tuple of (oom_killed, exit_code)
        """
        if not container_statuses:
            return False, 0

        oom_killed = False
        exit_code = 0

        for container_status in container_statuses:
            # Check current terminated state
            if container_status.state and container_status.state.terminated:
                terminated = container_status.state.terminated
                exit_code = terminated.exit_code or 0
                if terminated.reason == "OOMKilled":
                    oom_killed = True

            # Also check last_state for previous OOM
            if container_status.last_state and container_status.last_state.terminated:
                if container_status.last_state.terminated.reason == "OOMKilled":
                    oom_killed = True

        return oom_killed, exit_code

    def get_container_status(self, executor_name: str) -> Dict[str, Any]:
        """Get detailed status information for a K8s pod.

        This function retrieves pod state including:
        - Whether pod exists
        - Running/Succeeded/Failed/etc status
        - OOMKilled flag (indicates Out Of Memory kill)
        - Exit code from container

        Args:
            executor_name: Name of the pod (executor_name)

        Returns:
            dict: Pod status with the following fields:
                - exists (bool): Whether pod exists
                - status (str): Pod phase (running/succeeded/failed/etc)
                - oom_killed (bool): Whether container was killed due to OOM
                - exit_code (int): Container exit code
                - error_msg (str): Error message if any
        """
        try:
            core_v1 = self._get_core_v1_api()
            if core_v1 is None:
                return {
                    "exists": False,
                    "status": "error",
                    "oom_killed": False,
                    "exit_code": -1,
                    "error_msg": "Failed to get Kubernetes API client",
                }

            # Get pod by label selector
            label_selector = f"aigc.weibo.com/executor=wegent,app={executor_name}"
            pods = core_v1.list_namespaced_pod(
                namespace=K8S_NAMESPACE, label_selector=label_selector
            )

            if not pods.items:
                return {
                    "exists": False,
                    "status": "not_found",
                    "oom_killed": False,
                    "exit_code": -1,
                    "error_msg": None,
                }

            pod = pods.items[0]
            pod_phase = pod.status.phase.lower() if pod.status.phase else "unknown"

            # Check container status for OOM and exit code
            oom_killed, exit_code = self._extract_container_termination_info(
                pod.status.container_statuses
            )

            logger.debug(
                f"Pod status for {executor_name}: phase={pod_phase}, "
                f"oom_killed={oom_killed}, exit_code={exit_code}"
            )

            return {
                "exists": True,
                "status": pod_phase,
                "oom_killed": oom_killed,
                "exit_code": exit_code,
                "error_msg": None,
            }

        except ApiException as e:
            if e.status == 404:
                return {
                    "exists": False,
                    "status": "not_found",
                    "oom_killed": False,
                    "exit_code": -1,
                    "error_msg": None,
                }
            logger.error(f"Kubernetes API error getting pod status: {e}")
            return {
                "exists": False,
                "status": "error",
                "oom_killed": False,
                "exit_code": -1,
                "error_msg": str(e),
            }
        except Exception as e:
            logger.error(f"Error getting pod status for '{executor_name}': {e}")
            return {
                "exists": False,
                "status": "error",
                "oom_killed": False,
                "exit_code": -1,
                "error_msg": str(e),
            }

    @staticmethod
    def get_user_max_tasks(user_name: str) -> int:
        if not hasattr(K8sExecutor, "_user_task_limit_cache"):
            K8sExecutor._user_task_limit_cache = {}

        if not K8sExecutor._user_task_limit_cache:
            if USER_WHITELIST_TASK_LIMIT_MAP:
                try:
                    K8sExecutor._user_task_limit_cache = json.loads(
                        USER_WHITELIST_TASK_LIMIT_MAP
                    )
                    logger.info("Successfully parsed user whitelist task limit map")
                except (json.JSONDecodeError, TypeError) as e:
                    logger.error(f"Error parsing user whitelist task limit map: {e}")
                    K8sExecutor._user_task_limit_cache = {}

        return K8sExecutor._user_task_limit_cache.get(user_name, MAX_USER_TASKS)

    def cancel_task(self, task_id: int) -> Dict[str, Any]:
        """
        Cancel a running task by calling the executor's cancel API.

        Args:
            task_id (int): Task ID to cancel.

        Returns:
            Dict[str, Any]: Cancellation result with unified structure.
        """
        try:
            # Find the pod running this task
            core_v1 = self._get_core_v1_api()
            if core_v1 is None:
                return {
                    "status": "failed",
                    "error_msg": "Failed to get Kubernetes API client",
                }

            # Search for pods with the specific task_id label
            label_selector = f"aigc.weibo.com/executor=wegent,aigc.weibo.com/executor-task-id={task_id}"
            pods = core_v1.list_namespaced_pod(
                namespace=K8S_NAMESPACE, label_selector=label_selector
            )

            if not pods.items:
                logger.warning(f"No pod found for task {task_id}")
                return {
                    "status": "failed",
                    "error_msg": f"Task {task_id} is not currently running",
                }

            # Get the first matching pod (there should only be one)
            pod = pods.items[0]
            pod_name = pod.metadata.name
            pod_ip = pod.status.pod_ip

            if not pod_ip:
                logger.error(f"Pod {pod_name} has no IP address")
                return {
                    "status": "failed",
                    "error_msg": f"Pod for task {task_id} has no IP address",
                }

            # Call the executor's cancel API
            cancel_url = f"http://{pod_ip}:8080/api/tasks/cancel?task_id={task_id}"
            logger.info(f"Calling cancel API for task {task_id} at {cancel_url}")

            try:
                response = requests.post(cancel_url, timeout=10)
                response.raise_for_status()

                logger.info(f"Successfully cancelled task {task_id}")
                return {
                    "status": "success",
                    "pod_name": pod_name,
                    "message": f"Task {task_id} cancellation requested successfully",
                }
            except requests.exceptions.RequestException as e:
                logger.error(f"Failed to call cancel API for task {task_id}: {e}")
                return {
                    "status": "failed",
                    "error_msg": f"Failed to communicate with executor: {str(e)}",
                }

        except ApiException as e:
            logger.error(f"Kubernetes API error while cancelling task {task_id}: {e}")
            return {"status": "failed", "error_msg": f"Kubernetes API error: {str(e)}"}
        except Exception as e:
            logger.error(f"Error cancelling task {task_id}: {e}")
            return {"status": "failed", "error_msg": f"Error cancelling task: {str(e)}"}

    def _get_base_image_from_task(self, task: Dict[str, Any]) -> Optional[str]:
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

    def _report_validation_failure(
        self, task: Dict[str, Any], stage: str, error_message: str
    ) -> None:
        """
        Report validation failure to backend.

        Args:
            task: Task data containing validation_params
            stage: Current validation stage
            error_message: Error message to report
        """
        import httpx

        validation_params = task.get("validation_params", {})
        validation_id = validation_params.get("validation_id")

        if not validation_id:
            logger.debug("No validation_id in task, skipping failure report")
            return

        task_api_domain = os.getenv("TASK_API_DOMAIN", "http://localhost:8000")
        update_url = f"{task_api_domain}/api/shells/validation-status/{validation_id}"

        update_payload = {
            "status": "completed",
            "stage": stage,
            "progress": 100,
            "valid": False,
            "errorMessage": error_message,
        }

        try:
            with httpx.Client(timeout=10.0) as client:
                response = client.post(update_url, json=update_payload)
                if response.status_code == 200:
                    logger.info(
                        f"Reported validation failure: {validation_id} -> {stage}"
                    )
                else:
                    logger.warning(
                        f"Failed to report validation failure: {response.status_code} {response.text}"
                    )
        except Exception as e:
            logger.error(f"Error reporting validation failure: {e}")
