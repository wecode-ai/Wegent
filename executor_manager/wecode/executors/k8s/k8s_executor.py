# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Kubernetes executor for running tasks in K8s pods.

Uses unified ExecutionRequest from shared.models.execution.
"""

import json
import os
import threading
import time
from typing import Any, Dict, Optional, Union

import requests
from kubernetes import client, config
from kubernetes.client.rest import ApiException

from executor_manager.executors.base import Executor
from executor_manager.executors.docker.constants import (
    DEFAULT_API_ENDPOINT,
)
from executor_manager.utils.executor_name import generate_executor_name
from executor_manager.wecode.config.config import (
    EXECUTOR_DEFAULT_MAGE,
    K8S_NAMESPACE,
    MAX_USER_TASKS,
    USER_WHITELIST_TASK_LIMIT_MAP,
    WARMPOOL_ENABLED,
    WARMPOOL_TEMPLATE_NAME,
)
from executor_manager.wecode.executors.k8s.build_pod import build_pod_configuration
from shared.logger import setup_logger
from shared.models.execution import ExecutionRequest
from shared.models.openai_converter import get_metadata_field
from shared.status import TaskStatus
from shared.utils.http_client import traced_session, traced_sync_client

logger = setup_logger(__name__)

# Thread-local storage for API clients
_thread_local = threading.local()

# Global lock for configuration loading
_config_lock = threading.Lock()
_config_loaded = False


class PodCompletedError(RuntimeError):
    """Raised when an executor pod has already completed and must be recreated."""


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
    """Kubernetes executor for running tasks in K8s pods"""

    def __init__(self, requests_module=None):
        """
        Initialize K8s executor with dependency injection for better testability

        Args:
            requests_module: HTTP session for requests (default: traced_session with auto trace context)
        """
        # Ensure configuration is loaded during initialization
        if not _ensure_k8s_config_loaded():
            raise RuntimeError("Failed to configure Kubernetes client")
        self.requests = requests_module or traced_session()

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

    def _extract_task_info(self, task: Dict[str, Any]) -> Dict[str, Any]:
        """Extract basic task metadata from unified task payload."""
        task_id = get_metadata_field(task, "task_id", "-1")
        subtask_id = get_metadata_field(task, "subtask_id", "-1")
        user_config = get_metadata_field(task, "user", {})
        user_name = user_config.get("name", "unknown") if user_config else "unknown"
        executor_name = get_metadata_field(task, "executor_name")
        return {
            "task_id": task_id,
            "subtask_id": subtask_id,
            "user_name": user_name,
            "executor_name": executor_name,
        }

    def submit_executor(
        self,
        task: Union[Dict[str, Any], ExecutionRequest],
        callback: Optional[callable] = None,
    ) -> Dict[str, Any]:
        """
        Submit a Kubernetes pod for the given task.

        Args:
            task: Task information as dict or ExecutionRequest.
            callback: Optional callback function.

        Returns:
            Dict[str, Any]: Submission result.
        """
        # Convert ExecutionRequest to dict for internal processing
        task_dict = task.to_dict() if isinstance(task, ExecutionRequest) else task
        task_info = self._extract_task_info(task_dict)

        task_id = task_info["task_id"]
        subtask_id = task_info["subtask_id"]
        user_name = task_info["user_name"]

        # Check task type for special handling
        task_type = get_metadata_field(task_dict, "type")
        is_validation_task = task_type == "validation"
        is_subagent_task = task_type == "subagent"
        is_sandbox_task = task_type == "sandbox"

        status = "success"
        progress = 30
        error_msg = ""
        callback_status = TaskStatus.RUNNING.value

        executor_name = task_info["executor_name"]
        should_create_new_pod = not executor_name

        if executor_name:
            result = self._submit_to_existing_executor(
                task=task_dict,
                executor_name=executor_name,
                task_id=task_id,
                subtask_id=subtask_id,
            )
            # If pod completed, need to create a new pod
            if result["status"] == "pod_completed":
                should_create_new_pod = True
            else:
                status = result["status"]
                progress = result["progress"]
                error_msg = result["error_msg"]
                callback_status = result["callback_status"]

        if should_create_new_pod:
            # Create new pod, reuse executor_name if pod was completed, otherwise generate new one
            try:
                if not executor_name:
                    executor_name = generate_executor_name(
                        task_id, subtask_id, user_name
                    )

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
                    task_info["executor_name"] = executor_name
                    self.create_instance(task_dict, task_info, executor_name)

                    # Non-sandbox tasks must be explicitly dispatched after pod ready.
                    if not is_sandbox_task:
                        try:
                            ready_info = self.wait_instance_ready(executor_name)
                            dispatch_result = self.dispatch_task_to_instance(
                                task_dict, executor_name, ready_info
                            )
                            error_msg = dispatch_result.get("error_msg", "")
                        except Exception:
                            # Avoid leaking idle pod when initial dispatch fails.
                            try:
                                self.delete_executor(executor_name)
                            except Exception as cleanup_error:
                                logger.warning(
                                    f"Failed to cleanup pod {executor_name} after "
                                    f"initial dispatch failure: {cleanup_error}"
                                )
                            raise

                    # Register regular tasks to RunningTaskTracker for heartbeat monitoring.
                    self.register_task_for_heartbeat(
                        task_id=task_id,
                        subtask_id=subtask_id,
                        executor_name=executor_name,
                        task_type=get_metadata_field(task_dict, "type", "online"),
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
                logger.exception(
                    f"Error creating Kubernetes pod for task {task_id}: {e}"
                )
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

    def _submit_to_existing_executor(
        self,
        task: Dict[str, Any],
        executor_name: str,
        task_id: str,
        subtask_id: str,
    ) -> Dict[str, Any]:
        """
        Submit task to an existing executor pod.

        Checks whether pod should be recreated, then executes unified
        ready -> dispatch flow for running pods.

        Args:
            task: Task information
            executor_name: Name of the existing executor
            task_id: Task ID
            subtask_id: Subtask ID

        Returns:
            Dict with status, progress, error_msg, and callback_status
        """
        pod_result = self.get_pods_by_executor_name(executor_name)
        pod_list = pod_result.get("pods", [])
        logger.info(f"Found pods for executor {executor_name}: {pod_list}")

        if not pod_list:
            return {
                "status": "failed",
                "progress": 100,
                "error_msg": "Executor is deleted. Please create a new session.",
                "callback_status": TaskStatus.FAILED.value,
            }

        pod = pod_list[0]
        pod_name = pod.get("name")
        pod_status = pod.get("status")

        # If pod is Succeeded (completed), delete it and signal to create new pod
        if pod_status == "Succeeded":
            logger.info(
                f"Pod {executor_name} has completed (status: {pod_status}), "
                "deleting and signaling to create new pod"
            )
            self.delete_executor(pod_name)
            return {
                "status": "pod_completed",
                "progress": 30,
                "error_msg": "",
                "callback_status": TaskStatus.RUNNING.value,
            }

        try:
            ready_info = self.wait_instance_ready(executor_name)
            dispatch_result = self.dispatch_task_to_instance(
                task, executor_name, ready_info
            )
        except PodCompletedError:
            # Pod may complete between status query and dispatch.
            self.delete_executor(pod_name)
            return {
                "status": "pod_completed",
                "progress": 30,
                "error_msg": "",
                "callback_status": TaskStatus.RUNNING.value,
            }
        except Exception as e:
            return {
                "status": "failed",
                "progress": 100,
                "error_msg": str(e),
                "callback_status": TaskStatus.FAILED.value,
            }

        # Task sent successfully, register for heartbeat monitoring
        self.register_task_for_heartbeat(
            task_id=task_id,
            subtask_id=subtask_id,
            executor_name=executor_name,
            task_type=get_metadata_field(task, "type", "online"),
            context=f"existing executor: {executor_name}",
        )
        return {
            "status": "success",
            "progress": 30,
            "error_msg": dispatch_result.get("error_msg", ""),
            "callback_status": TaskStatus.RUNNING.value,
        }

    def _send_task_to_container(
        self,
        task: Dict[str, Any],
        host: str,
        port: int,
        timeout: Optional[float] = None,
    ) -> requests.Response:
        """Send task to runtime API endpoint."""
        endpoint = f"http://{host}:{port}{DEFAULT_API_ENDPOINT}"
        logger.info(f"Sending task to {endpoint}")
        request_kwargs = {}
        if timeout is not None:
            request_kwargs["timeout"] = timeout
        return self.requests.post(endpoint, json=task, **request_kwargs)

    def create_instance(
        self, task: Dict[str, Any], task_info: Dict[str, Any], executor_name: str
    ) -> None:
        """Create a new Kubernetes runtime pod (or warm-pool sandbox)."""
        task_id = task_info["task_id"]
        user_name = task_info["user_name"]
        image = get_metadata_field(task, "executor_image", EXECUTOR_DEFAULT_MAGE)
        is_sandbox_task = get_metadata_field(task, "type") == "sandbox"

        # Check if warm pool is enabled for sandbox tasks.
        if WARMPOOL_ENABLED and is_sandbox_task:
            pod_result = self._create_pod_from_warmpool(
                task=task,
                executor_name=executor_name,
                user_name=user_name,
                task_id=task_id,
                subtask_id=task_info["subtask_id"],
            )
        else:
            base_image = self._get_base_image_from_task(task)
            if base_image:
                logger.info(
                    f"Using custom base image: {base_image} with InitContainer pattern"
                )

            pod = build_pod_configuration(
                user_name,
                executor_name,
                K8S_NAMESPACE,
                task,
                image,
                task_id,
                get_metadata_field(task, "mode", "default"),
            )
            pod_result = self._submit_kubernetes_pod(
                pod, K8S_NAMESPACE, executor_name, task_id
            )

        if not pod_result or pod_result.get("status") != "success":
            error_msg = (
                pod_result.get("error_msg", "Kubernetes pod creation failed")
                if pod_result
                else "Kubernetes pod creation failed"
            )
            raise RuntimeError(error_msg)

    def wait_instance_ready(self, executor_name: str) -> Dict[str, Any]:
        """Wait until Kubernetes pod is running and HTTP endpoint is available."""
        max_retries = max(
            int(
                os.getenv(
                    "EXECUTOR_READY_MAX_RETRIES",
                    os.getenv("SANDBOX_READY_MAX_RETRIES", "180"),
                )
            ),
            1,
        )
        retry_interval = max(
            float(
                os.getenv(
                    "EXECUTOR_READY_INTERVAL",
                    os.getenv("SANDBOX_READY_INTERVAL", "1"),
                )
            ),
            0.0,
        )
        success_threshold = max(
            int(os.getenv("EXECUTOR_READY_SUCCESS_THRESHOLD", "1")),
            1,
        )

        success_count = 0
        last_error = "pod not ready"

        for attempt in range(1, max_retries + 1):
            pod_result = self.get_pods_by_executor_name(executor_name)
            pods = pod_result.get("pods", [])

            if pod_result.get("status") != "success":
                success_count = 0
                last_error = pod_result.get("error_msg", "failed to list pod status")
            elif not pods:
                success_count = 0
                last_error = "pod does not exist"
            else:
                pod = pods[0]
                pod_status = pod.get("status")
                host = pod.get("ip")

                if pod_status == "Succeeded":
                    raise PodCompletedError(
                        f"Pod {executor_name} already completed before dispatch"
                    )
                if pod_status != "Running":
                    success_count = 0
                    last_error = f"pod status is '{pod_status}'"
                elif not host:
                    success_count = 0
                    last_error = "pod has no IP address"
                elif self._is_instance_http_ready(host, 8080):
                    success_count += 1
                    if success_count >= success_threshold:
                        logger.info(
                            f"Pod ready: {executor_name}, host={host}, "
                            f"attempt={attempt}/{max_retries}"
                        )
                        return {"host": host, "port": 8080}
                else:
                    success_count = 0
                    last_error = "http health probe failed"

            logger.debug(
                f"Waiting pod ready {attempt}/{max_retries} for {executor_name}: "
                f"{last_error}"
            )
            if attempt < max_retries and retry_interval > 0:
                time.sleep(retry_interval)

        raise RuntimeError(f"Pod {executor_name} failed to become ready: {last_error}")

    def dispatch_task_to_instance(
        self,
        task: Dict[str, Any],
        executor_name: str,
        ready_info: Dict[str, Any],
    ) -> Dict[str, Any]:
        """Dispatch first task payload to a ready Kubernetes pod."""
        host = ready_info.get("host")
        port = ready_info.get("port", 8080)
        if not host:
            raise RuntimeError(f"Ready info for {executor_name} does not contain host")
        return self._dispatch_initial_task_to_instance(task, executor_name, host, port)

    def _is_instance_http_ready(self, host: str, port: int) -> bool:
        """Check runtime HTTP readiness via /ready then fallback /."""
        timeout = float(os.getenv("EXECUTOR_READY_HTTP_TIMEOUT", "2"))
        endpoints = ["/ready", "/"]
        for path in endpoints:
            url = f"http://{host}:{port}{path}"
            try:
                response = self.requests.get(url, timeout=timeout)
                if response.status_code < 500:
                    return True
            except requests.RequestException:
                continue
        return False

    def _dispatch_initial_task_to_instance(
        self, task: Dict[str, Any], executor_name: str, host: str, port: int
    ) -> Dict[str, Any]:
        """Dispatch first task request with retries and timeout controls."""
        max_retries = max(
            int(os.getenv("EXECUTOR_INITIAL_DISPATCH_MAX_RETRIES", "3")),
            1,
        )
        retry_interval = max(
            float(os.getenv("EXECUTOR_INITIAL_DISPATCH_RETRY_INTERVAL", "1")),
            0.0,
        )
        request_timeout = max(
            float(os.getenv("EXECUTOR_INITIAL_DISPATCH_TIMEOUT", "10")),
            0.1,
        )
        last_error = "unknown error"

        for attempt in range(1, max_retries + 1):
            try:
                response = self._send_task_to_container(
                    task,
                    host,
                    port,
                    timeout=request_timeout,
                )
                if response.status_code == 200:
                    error_msg = ""
                    try:
                        error_msg = response.json().get("error_msg", "")
                    except Exception:
                        error_msg = ""
                    logger.info(
                        f"Initial task dispatched successfully to {executor_name} "
                        f"(attempt {attempt}/{max_retries})"
                    )
                    return {"status": "success", "error_msg": error_msg}

                response_text = getattr(response, "text", "") or ""
                last_error = (
                    f"status={response.status_code}, response={response_text[:500]}"
                )
            except requests.RequestException as e:
                last_error = str(e)

            logger.warning(
                f"Initial task dispatch attempt {attempt}/{max_retries} failed for "
                f"{executor_name}: {last_error}"
            )
            if attempt < max_retries and retry_interval > 0:
                time.sleep(retry_interval)

        raise RuntimeError(
            f"Failed to dispatch initial task to pod {executor_name}: {last_error}"
        )

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

    def _create_pod_from_warmpool(
        self,
        task: Dict[str, Any],
        executor_name: str,
        user_name: str,
        task_id: str,
        subtask_id: str,  # noqa: ARG002 - kept for consistency with other methods
    ) -> Dict[str, Any]:
        """Create a pod from the warm pool by claiming a SandboxClaim.

        Args:
            task: Task information
            executor_name: Name for the executor
            user_name: User name
            task_id: Task ID
            subtask_id: Subtask ID

        Returns:
            dict with status and error_msg if failed
        """
        from executor_manager.wecode.config.config import (
            CALLBACK_URL,
            EXECUTOR_MANAGER_HEARTBEAT_BASE_URL,
            TASK_API_DOMAIN,
        )
        from executor_manager.wecode.executors.warmpool import WarmPoolClient
        from executor_manager.wecode.executors.warmpool.constants import (
            ANNOTATION_AUTH_TOKEN,
            ANNOTATION_CALLBACK_URL,
            ANNOTATION_EMAIL,
            ANNOTATION_HEARTBEAT_BASE_URL,
            ANNOTATION_HEARTBEAT_ENABLED,
            ANNOTATION_HEARTBEAT_ID,
            ANNOTATION_HEARTBEAT_TYPE,
            ANNOTATION_TASK_API_DOMAIN,
            LABEL_EXECUTOR,
            LABEL_EXECUTOR_VALUE,
            LABEL_PROXY_USER,
            LABEL_TASK_ID,
            LABEL_TASK_TYPE,
            LABEL_TEAM_MODE,
            LABEL_USER,
        )

        api_client = _get_api_client()
        if api_client is None:
            return {
                "status": "failed",
                "error_msg": "Failed to get Kubernetes API client",
            }

        warmpool_client = WarmPoolClient(api_client, K8S_NAMESPACE)

        try:
            # Check if SandboxClaim already exists (reuse existing sandbox)
            existing_claim = warmpool_client.get_sandbox_claim(executor_name)
            if existing_claim:
                logger.info(
                    f"SandboxClaim '{executor_name}' already exists for task {task_id}, reusing existing sandbox"
                )
                # Get sandbox status to retrieve pod info
                sandbox_status = warmpool_client.get_sandbox_status(executor_name)
                if (
                    sandbox_status.get("exists")
                    and sandbox_status.get("phase") == "Running"
                ):
                    logger.info(
                        f"Existing sandbox '{executor_name}' is running, reusing"
                    )
                    return {"status": "success"}
                else:
                    # Sandbox exists but not running, wait for it to be ready
                    sandbox_status = self._wait_for_warmpool_sandbox_ready(
                        warmpool_client, executor_name, timeout=60
                    )
                    if sandbox_status:
                        return {"status": "success"}
                    return {
                        "status": "failed",
                        "error_msg": "Existing sandbox pod did not become ready in time",
                    }

            # Create SandboxClaim CR (claims pod from warm pool)
            # Note: labels/annotations passed here are for the SandboxClaim CR itself,
            # not for the Pod. Pod metadata is patched separately after sandbox is ready.
            warmpool_client.create_sandbox_claim(
                name=executor_name,
                template_name=WARMPOOL_TEMPLATE_NAME,
                labels={},
                annotations={},
            )

            logger.info(
                f"Created SandboxClaim '{executor_name}' for task {task_id} from warm pool"
            )

            # Wait for sandbox to be ready
            sandbox_status = self._wait_for_warmpool_sandbox_ready(
                warmpool_client, executor_name, timeout=60
            )

            if not sandbox_status:
                return {
                    "status": "failed",
                    "error_msg": "Sandbox pod did not become ready in time",
                }

            # Build labels and annotations for Pod (injected via patch after sandbox is ready)
            labels = {
                "app": executor_name,
                LABEL_EXECUTOR: LABEL_EXECUTOR_VALUE,
                LABEL_TASK_ID: str(task_id),
                LABEL_USER: user_name,
                LABEL_PROXY_USER: user_name,
                LABEL_TASK_TYPE: get_metadata_field(task, "type", "online"),
                LABEL_TEAM_MODE: get_metadata_field(task, "mode", "default"),
            }
            annotations = {
                ANNOTATION_EMAIL: "weibo_ai_coding@weibo.com",
                ANNOTATION_HEARTBEAT_ENABLED: "true",
                ANNOTATION_HEARTBEAT_TYPE: "sandbox",
                # Use task_id as heartbeat_id for sandbox lookup compatibility
                ANNOTATION_HEARTBEAT_ID: str(task_id),
            }
            auth_token = get_metadata_field(task, "auth_token")
            if auth_token:
                annotations[ANNOTATION_AUTH_TOKEN] = auth_token
            if TASK_API_DOMAIN:
                annotations[ANNOTATION_TASK_API_DOMAIN] = TASK_API_DOMAIN
            if EXECUTOR_MANAGER_HEARTBEAT_BASE_URL:
                annotations[ANNOTATION_HEARTBEAT_BASE_URL] = (
                    EXECUTOR_MANAGER_HEARTBEAT_BASE_URL
                )
            if CALLBACK_URL:
                annotations[ANNOTATION_CALLBACK_URL] = CALLBACK_URL

            # Patch Pod labels and annotations with task-specific data
            pod_name = sandbox_status.get("pod_name")
            if pod_name:
                warmpool_client.patch_pod_metadata(
                    pod_name=pod_name,
                    labels=labels,
                    annotations=annotations,
                )

            # Save executor binding with sandbox_claim_name for GC to delete SandboxClaim
            from executor_manager.services.sandbox.repository import (
                get_sandbox_repository,
            )

            repository = get_sandbox_repository()
            repository.save_executor_binding(
                task_id=int(task_id),
                executor_name=executor_name,
                sandbox_claim_name=executor_name,  # SandboxClaim name equals executor_name
            )

            return {"status": "success"}

        except ApiException as e:
            logger.error(
                f"Kubernetes API error creating sandbox from warm pool for task {task_id}: {e}"
            )
            return {"status": "failed", "error_msg": f"Kubernetes API error: {e}"}
        except Exception as e:
            logger.error(
                f"Error creating sandbox from warm pool for task {task_id}: {e}"
            )
            return {"status": "failed", "error_msg": f"Error: {e}"}

    def _wait_for_warmpool_sandbox_ready(
        self,
        warmpool_client,
        name: str,
        timeout: int = 60,
    ) -> Optional[Dict[str, Any]]:
        """Wait for sandbox pod to be ready.

        Args:
            warmpool_client: WarmPool client instance
            name: Sandbox name
            timeout: Maximum wait time in seconds

        Returns:
            Sandbox status dict if ready, None otherwise
        """
        from executor_manager.wecode.executors.warmpool.constants import (
            SANDBOX_PHASE_FAILED,
            SANDBOX_PHASE_RUNNING,
            SANDBOX_PHASE_TERMINATED,
        )

        start_time = time.time()

        while time.time() - start_time < timeout:
            status = warmpool_client.get_sandbox_status(name)
            phase = status.get("phase", "")

            if phase in (SANDBOX_PHASE_FAILED, SANDBOX_PHASE_TERMINATED):
                logger.error(f"Sandbox {name} failed (phase: {phase})")
                return None

            if phase == SANDBOX_PHASE_RUNNING:
                # Verify service is accessible
                host = status.get("service_fqdn") or status.get("pod_ip")
                if host and self._check_warmpool_service_health(host, port=8080):
                    logger.info(f"Sandbox {name} is running and service is accessible")
                    return status
                else:
                    logger.debug(
                        f"Sandbox {name} is running but service not yet accessible"
                    )
            else:
                logger.debug(f"Waiting for sandbox {name}, current phase: {phase}")

            time.sleep(2)

        logger.error(f"Timeout waiting for sandbox {name}")
        return None

    def _check_warmpool_service_health(
        self,
        host: str,
        port: int = 8080,
        timeout: float = 3.0,
    ) -> bool:
        """Check if service is accessible via health endpoint.

        Args:
            host: Service host (FQDN or IP)
            port: Service port
            timeout: Request timeout in seconds

        Returns:
            True if service is accessible, False otherwise
        """
        try:
            health_url = f"http://{host}:{port}/health"
            response = requests.get(health_url, timeout=timeout)
            if response.status_code == 200:
                return True
        except requests.exceptions.RequestException:
            pass

        try:
            root_url = f"http://{host}:{port}/"
            response = requests.get(root_url, timeout=timeout)
            return True
        except requests.exceptions.RequestException as e:
            logger.debug(f"Service health check failed for {host}:{port}: {e}")
            return False

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

    def delete_sandbox_claim(self, sandbox_claim_name: str) -> Dict[str, Any]:
        """Delete a SandboxClaim CR (for warm pool sandboxes).

        When a sandbox is created from warm pool, deleting the SandboxClaim
        will trigger the controller to clean up the associated Sandbox and Pod.

        Args:
            sandbox_claim_name: Name of the SandboxClaim to delete

        Returns:
            Dict with status and error_msg if failed
        """
        from executor_manager.wecode.executors.warmpool import WarmPoolClient

        try:
            api_client = _get_api_client()
            if api_client is None:
                return {
                    "status": "failed",
                    "error_msg": "Failed to get Kubernetes API client",
                }

            warmpool_client = WarmPoolClient(api_client, K8S_NAMESPACE)
            warmpool_client.delete_sandbox_claim(sandbox_claim_name)
            logger.info(f"Deleted SandboxClaim '{sandbox_claim_name}'")
            return {"status": "success"}
        except ApiException as e:
            if e.status == 404:
                logger.warning(
                    f"SandboxClaim '{sandbox_claim_name}' not found in namespace {K8S_NAMESPACE}"
                )
                return {
                    "status": "not_found",
                    "error_msg": f"SandboxClaim '{sandbox_claim_name}' not found",
                }
            else:
                logger.error(
                    f"Kubernetes API error deleting SandboxClaim '{sandbox_claim_name}': {e}"
                )
                return {"status": "failed", "error_msg": f"Kubernetes API error: {e}"}
        except Exception as e:
            logger.error(f"Error deleting SandboxClaim '{sandbox_claim_name}': {e}")
            return {"status": "failed", "error_msg": f"Error: {e}"}

    def delete_executor_by_task_id(self, task_id: str) -> Dict[str, Any]:
        """Delete executor by task_id.

        First checks if there's a SandboxClaim binding in Redis (for warm pool sandboxes).
        If so, deletes the SandboxClaim which cascades to delete Sandbox and Pod.
        Otherwise, falls back to searching and deleting pods by task_id label.

        Args:
            task_id: Task ID to search for

        Returns:
            Dict with status and error_msg if failed
        """
        # First, check if there's a SandboxClaim binding in Redis
        from executor_manager.services.sandbox.repository import get_sandbox_repository

        try:
            repository = get_sandbox_repository()
            binding = repository.load_executor_binding_full(int(task_id))

            if binding and binding.get("sandbox_claim_name"):
                sandbox_claim_name = binding["sandbox_claim_name"]
                logger.info(
                    f"Found sandbox_claim_name '{sandbox_claim_name}' in binding for task {task_id}, "
                    "deleting SandboxClaim"
                )
                return self.delete_sandbox_claim(sandbox_claim_name)
        except Exception as e:
            logger.debug(f"Error checking binding for task {task_id}: {e}")

        # Fall back to searching and deleting pods by task_id label
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
        start_time = time.time()
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

            # Use _preload_content=False to skip SDK deserialization of V1PodList
            # This significantly improves performance when listing many pods
            # (SDK deserialization can take 17+ seconds for 300+ pods)
            response = core_v1.list_namespaced_pod(
                namespace=K8S_NAMESPACE,
                label_selector=label_selector,
                _preload_content=False,
            )

            # Parse JSON manually to extract task IDs
            data = json.loads(response.data.decode("utf-8"))
            items = data.get("items", [])

            task_ids = set()
            for pod in items:
                # Extract task ID from pod labels using the correct label name
                labels = pod.get("metadata", {}).get("labels", {})
                if labels and "aigc.weibo.com/executor-task-id" in labels:
                    task_ids.add(labels["aigc.weibo.com/executor-task-id"])
                # If no explicit task ID label exists, log warning
                else:
                    pod_name = pod.get("metadata", {}).get("name", "unknown")
                    logger.warning(f"Pod {pod_name} has no task ID label.")

            task_ids = list(task_ids)

            elapsed = time.time() - start_time
            logger.info(
                f"Found {len(task_ids)} task IDs with label selector '{label_selector}' "
                f"(took {elapsed:.2f}s)"
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
            # Use _preload_content=False to skip SDK deserialization
            response = core_v1.list_namespaced_pod(
                namespace=K8S_NAMESPACE,
                label_selector=label_selector,
                _preload_content=False,
            )
            data = json.loads(response.data.decode("utf-8"))
            return len(data.get("items", []))
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
                response = self.requests.post(cancel_url, timeout=10)
                response.raise_for_status()

                logger.info(f"Successfully cancelled task {task_id}")
                return {
                    "status": "success",
                    "pod_name": pod_name,
                    "message": f"Task {task_id} cancellation requested successfully",
                }
            except requests.RequestException as e:
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
        bots = get_metadata_field(task, "bot", [])
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
        validation_params = get_metadata_field(task, "validation_params", {})
        validation_id = (
            validation_params.get("validation_id") if validation_params else None
        )

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
            with traced_sync_client(timeout=10.0) as client:
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
