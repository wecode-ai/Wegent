# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Kubernetes executor for running tasks in K8s pods.

Uses unified ExecutionRequest from shared.models.execution.
"""

import asyncio
import json
import os
import threading
import time
from datetime import datetime, timedelta, timezone
from http import HTTPStatus
from typing import Any, Dict, List, Optional, Union
from urllib.parse import urlparse

import requests
from kubernetes import client, config
from kubernetes.client.rest import ApiException

from executor_manager.executors.base import Executor
from executor_manager.executors.docker.constants import (
    DEFAULT_API_ENDPOINT,
)
from executor_manager.utils.executor_info import attach_executor_info
from executor_manager.utils.executor_name import generate_executor_name
from executor_manager.wecode.config.config import (
    EXECUTOR_DEFAULT_MAGE,
    EXECUTOR_GIT_WARMPOOL_ENABLED,
    EXECUTOR_NON_GIT_WARMPOOL_ENABLED,
    EXECUTOR_WARMPOOL_ENABLED,
    K8S_NAMESPACE,
    MAX_USER_TASKS,
    USER_WHITELIST_TASK_LIMIT_MAP,
    WARMPOOL_ENABLED,
    WARMPOOL_TEMPLATE_NAME,
)
from executor_manager.wecode.executors.k8s.build_pod import build_pod_configuration
from executor_manager.wecode.executors.k8s.git_warmpool import (
    runtime_ineligibility_reason as git_warmpool_runtime_ineligibility_reason,
)
from executor_manager.wecode.executors.k8s.git_warmpool import (
    serialize_k8s_resource,
)
from executor_manager.wecode.executors.k8s.pod_lookup import (
    lookup_pod_owners_by_ip,
)
from executor_manager.wecode.executors.warmpool.constants import (
    LABEL_EXECUTOR,
    LABEL_EXECUTOR_VALUE,
    LABEL_POOL_PROFILE,
    LABEL_POOL_STATE,
    LABEL_TASK_ID,
    LABEL_WARM_POOL,
    POOL_PROFILE_EXECUTOR_STANDARD,
    SANDBOX_API_GROUP,
    SANDBOX_KIND,
)
from shared.logger import setup_logger
from shared.models.execution import (
    GIT_AUTH_TRANSPORT_ENCRYPTED_REQUEST_TOKEN,
    ExecutionRequest,
)
from shared.models.openai_converter import get_metadata_field
from shared.status import TaskStatus
from shared.utils.crypto import is_token_encrypted
from shared.utils.http_client import traced_session, traced_sync_client
from shared.utils.task_identity import build_task_identity_env
from shared.utils.url_util import domains_match

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
        prepare_only = bool(get_metadata_field(task_dict, "prepare_only", False))

        status = "success"
        progress = 30
        error_msg = ""
        callback_status = TaskStatus.RUNNING.value

        executor_name = task_info["executor_name"]
        should_create_new_pod = not executor_name

        if executor_name:
            attach_executor_info(task_dict, executor_name, K8S_NAMESPACE)
            if prepare_only:
                pod_result = self.get_pods_by_executor_name(executor_name)
                pod_list = pod_result.get("pods", [])
                if pod_list and pod_list[0].get("status") != "Succeeded":
                    self.wait_instance_ready(executor_name)
                else:
                    should_create_new_pod = True
            else:
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
                attach_executor_info(task_dict, executor_name, K8S_NAMESPACE)

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

                    if not is_sandbox_task:
                        try:
                            ready_info = self.wait_instance_ready(executor_name)
                            if prepare_only:
                                logger.info(
                                    f"Prepared pod {executor_name} and confirmed it is ready"
                                )
                            else:
                                dispatch_result = self.dispatch_task_to_instance(
                                    task_dict, executor_name, ready_info
                                )
                                error_msg = dispatch_result.get("error_msg", "")
                        except Exception:
                            # Pod is intentionally kept alive for debugging.
                            # Do NOT delete it here; the failure callback below
                            # will inform the frontend of the error.
                            logger.warning(
                                f"Initial dispatch failed for pod {executor_name}; "
                                "pod is preserved for debugging."
                            )
                            raise

                    # A prepared executor has not started task execution yet. Register it
                    # only after the first real dispatch so warm pods do not time out
                    # while waiting for the user request.
                    if not prepare_only:
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

                if prepare_only and executor_name:
                    self._cleanup_prepare_pod(executor_name, task_id)

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

                if prepare_only and executor_name:
                    self._cleanup_prepare_pod(executor_name, task_id)

                # For validation tasks, report failure via dedicated API.
                # For regular/subagent tasks, push FAILED status to backend so
                # the frontend is not left indefinitely in "processing" state.
                if is_validation_task:
                    self._report_validation_failure(
                        task, "starting_container", error_msg
                    )
                else:
                    self._send_failure_callback(
                        task_id=task_id,
                        subtask_id=subtask_id,
                        executor_name=executor_name,
                        error_message=error_msg,
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

    def _cleanup_prepare_pod(self, executor_name: str, task_id: str) -> None:
        """Delete a pod left behind by a failed prepare.

        Prepare does not dispatch a task, so a pod that never became ready has no
        debugging value and would otherwise make the next retry collide on
        AlreadyExists. Best-effort: failures here must not mask the original error.
        """
        try:
            result = self.delete_executor(executor_name, K8S_NAMESPACE)
            logger.info(
                f"+++ Cleaned up leftover prepare pod '{executor_name}' for task "
                f"{task_id}: {result.get('status')}"
            )
        except Exception as e:
            logger.warning(
                f"+++ Failed to clean up leftover prepare pod '{executor_name}' for "
                f"task {task_id}: {e}"
            )

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
        executor_warmpool_reason = self._executor_warmpool_ineligibility_reason(
            task, image
        )
        use_executor_warmpool = (
            WARMPOOL_ENABLED
            and EXECUTOR_WARMPOOL_ENABLED
            and not is_sandbox_task
            and executor_warmpool_reason is None
        )

        # Check if warm pool is enabled for sandbox tasks.
        if WARMPOOL_ENABLED and is_sandbox_task:
            pod_result = self._create_pod_from_warmpool(
                task=task,
                executor_name=executor_name,
                user_name=user_name,
                task_id=task_id,
                subtask_id=task_info["subtask_id"],
            )
        elif use_executor_warmpool:
            if not WARMPOOL_TEMPLATE_NAME:
                raise RuntimeError(
                    "WARMPOOL_TEMPLATE_NAME is required when the standard "
                    "Executor warm pool is enabled"
                )
            pod_result = self._create_pod_from_warmpool(
                task=task,
                executor_name=executor_name,
                user_name=user_name,
                task_id=task_id,
                subtask_id=task_info["subtask_id"],
                template_name=WARMPOOL_TEMPLATE_NAME,
                workload_type="executor",
            )
            fallback_reason = (pod_result or {}).get("fallback_reason")
            if fallback_reason:
                logger.warning(
                    "Executor warm pool falling back to direct Pod for task %s: %s",
                    task_id,
                    fallback_reason,
                )
                pod_result = self._create_direct_pod(
                    task,
                    executor_name,
                    user_name,
                    task_id,
                    image,
                )
        else:
            if EXECUTOR_WARMPOOL_ENABLED and not is_sandbox_task:
                logger.info(
                    "Executor warm pool skipped for task %s: %s",
                    task_id,
                    executor_warmpool_reason or "shared_warmpool_disabled",
                )
            pod_result = self._create_direct_pod(
                task,
                executor_name,
                user_name,
                task_id,
                image,
            )

        if not pod_result or pod_result.get("status") != "success":
            error_msg = (
                pod_result.get("error_msg", "Kubernetes pod creation failed")
                if pod_result
                else "Kubernetes pod creation failed"
            )
            raise RuntimeError(error_msg)

    def _create_direct_pod(
        self,
        task: Dict[str, Any],
        executor_name: str,
        user_name: str,
        task_id: str,
        image: str,
    ) -> Dict[str, Any]:
        """Create the task-specific Pod used when warm-pool claims are unsafe."""
        base_image = self._get_base_image_from_task(task)
        if base_image:
            logger.info(
                "Using custom base image: %s with InitContainer pattern", base_image
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
        return self._submit_kubernetes_pod(pod, K8S_NAMESPACE, executor_name, task_id)

    def _executor_warmpool_ineligibility_reason(
        self, task: Dict[str, Any], image: str
    ) -> Optional[str]:
        """Return why a task cannot use the standard executor warm pool."""
        if get_metadata_field(task, "type", "online") != "online":
            return "unsupported_task_type"
        if image != EXECUTOR_DEFAULT_MAGE:
            return "executor_image_mismatch"
        if self._get_base_image_from_task(task):
            return "custom_base_image"
        if self._task_has_git_repository(task):
            return self._git_warmpool_ineligibility_reason(task)
        if not EXECUTOR_NON_GIT_WARMPOOL_ENABLED:
            return "non_git_warmpool_disabled"
        return None

    @staticmethod
    def _git_warmpool_ineligibility_reason(task: Dict[str, Any]) -> Optional[str]:
        """Return why a Git task cannot safely claim a shared warm sandbox."""

        if not EXECUTOR_GIT_WARMPOOL_ENABLED:
            return "git_warmpool_disabled"
        if get_metadata_field(task, "workspace_source") == "git_worktree":
            return "git_worktree"

        git_url = K8sExecutor._task_git_url(task)
        parsed_url = urlparse(git_url)
        if parsed_url.scheme != "https" or not parsed_url.hostname:
            return "git_requires_https"
        if (
            parsed_url.username
            or parsed_url.password
            or parsed_url.query
            or parsed_url.fragment
        ):
            return "git_url_contains_credentials"

        if (
            get_metadata_field(task, "git_auth_transport")
            != GIT_AUTH_TRANSPORT_ENCRYPTED_REQUEST_TOKEN
        ):
            return "git_credentials_not_request_scoped"

        user = get_metadata_field(task, "user", {}) or {}
        if not isinstance(user, dict):
            return "git_credentials_missing"
        token = str(user.get("git_token") or user.get("gitToken") or "").strip()
        if not token or token == "***":
            return "git_credentials_missing"
        if not is_token_encrypted(token):
            return "git_credentials_not_encrypted"

        credential_domain = str(
            user.get("git_domain") or user.get("gitDomain") or ""
        ).strip()
        if not credential_domain or not domains_match(
            credential_domain, parsed_url.hostname
        ):
            return "git_credential_domain_mismatch"
        return None

    @staticmethod
    def _task_git_url(task: Dict[str, Any]) -> str:
        git_url = str(get_metadata_field(task, "git_url", "") or "").strip()
        if git_url:
            return git_url
        workspace = get_metadata_field(task, "workspace", {}) or {}
        repository = (
            workspace.get("repository") if isinstance(workspace, dict) else None
        )
        if not isinstance(repository, dict):
            return ""
        return str(repository.get("gitUrl") or repository.get("git_url") or "").strip()

    @staticmethod
    def _task_has_git_repository(task: Dict[str, Any]) -> bool:
        """Return whether the task is associated with a Git repository."""
        if any(
            get_metadata_field(task, field)
            for field in ("git_url", "git_repo", "git_repo_id")
        ):
            return True

        if get_metadata_field(task, "workspace_source") == "git_worktree":
            return True

        workspace = get_metadata_field(task, "workspace", {}) or {}
        repository = (
            workspace.get("repository") if isinstance(workspace, dict) else None
        )
        if not isinstance(repository, dict):
            return False
        return any(
            repository.get(field) for field in ("gitUrl", "gitRepo", "gitRepoId")
        )

    @staticmethod
    def _discard_incompatible_warmpool_claim(
        warmpool_client, executor_name: str, task_id: str
    ) -> None:
        try:
            if warmpool_client.get_sandbox_claim(executor_name):
                warmpool_client.delete_sandbox_claim(executor_name)
        except Exception as error:
            logger.warning(
                "Failed to discard incompatible SandboxClaim '%s' for task %s: %s",
                executor_name,
                task_id,
                error,
            )

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
            int(os.getenv("EXECUTOR_INITIAL_DISPATCH_MAX_RETRIES", "1")),
            1,
        )
        retry_interval = max(
            float(os.getenv("EXECUTOR_INITIAL_DISPATCH_RETRY_INTERVAL", "1")),
            0.0,
        )
        request_timeout = max(
            float(os.getenv("EXECUTOR_INITIAL_DISPATCH_TIMEOUT", "30")),
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

        return self._create_pod(core_v1, pod, namespace, pod_name, task_id)

    def _create_pod(
        self, core_v1, pod, namespace, pod_name, task_id, allow_reconcile=True
    ):
        """Create a pod, reconciling AlreadyExists so retries stay idempotent."""
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
        except ApiException as e:
            # HTTP 409 AlreadyExists: the pod was left by a prior prepare whose
            # response was cut off (e.g. gateway timeout).
            already_exists = e.status == HTTPStatus.CONFLICT
            if already_exists and allow_reconcile:
                return self._reconcile_existing_pod(
                    core_v1, pod, namespace, pod_name, task_id
                )
            logger.error(
                f"Failed to create Kubernetes pod '{pod_name}' for task {task_id}: {e}"
            )
            return {"status": "failed", "pod_name": pod_name, "error_msg": str(e)}
        except Exception as e:
            # Intentional catch-all: any unexpected error must surface as a
            # "failed" result dict instead of propagating, so the caller can
            # report the failure and clean up consistently.
            logger.error(
                f"Failed to create Kubernetes pod '{pod_name}' for task {task_id}: {e}"
            )
            return {"status": "failed", "pod_name": pod_name, "error_msg": str(e)}

    def _reconcile_existing_pod(self, core_v1, pod, namespace, pod_name, task_id):
        """Reconcile a create-time 409 AlreadyExists.

        A prior prepare attempt may have created the pod but had its response cut
        off by an upstream gateway timeout, so the caller retries with the same
        pod name. Adopt the pod when it is still usable; otherwise delete the
        stale pod and recreate it so the retry does not loop on AlreadyExists.
        """
        try:
            existing = core_v1.read_namespaced_pod(name=pod_name, namespace=namespace)
        except ApiException as e:
            if e.status == HTTPStatus.NOT_FOUND:
                logger.info(
                    f"+++ Pod '{pod_name}' disappeared after 409; recreating for task {task_id}"
                )
                return self._create_pod(
                    core_v1, pod, namespace, pod_name, task_id, allow_reconcile=False
                )
            logger.error(
                f"+++ Failed to read existing pod '{pod_name}' for task {task_id}: {e}"
            )
            return {"status": "failed", "pod_name": pod_name, "error_msg": str(e)}

        phase = getattr(existing.status, "phase", None) if existing.status else None
        being_deleted = bool(getattr(existing.metadata, "deletion_timestamp", None))
        pod_age = self._pod_age_seconds(existing)

        if self._is_pod_adoptable(existing):
            logger.info(
                f"+++ Adopting existing pod '{pod_name}' (phase={phase}, "
                f"age={pod_age:.0f}s) for task {task_id}"
            )
            return {"status": "success", "pod_name": pod_name}

        logger.warning(
            f"+++ Recreating existing pod '{pod_name}' for task {task_id} "
            f"(phase={phase}, deleting={being_deleted}, age={pod_age})"
        )
        self.delete_executor(pod_name, namespace)
        if not self._wait_pod_deleted(core_v1, namespace, pod_name):
            return {
                "status": "failed",
                "pod_name": pod_name,
                "error_msg": f"Stale pod '{pod_name}' did not terminate in time",
            }
        return self._create_pod(
            core_v1, pod, namespace, pod_name, task_id, allow_reconcile=False
        )

    @staticmethod
    def _pod_age_seconds(existing) -> Optional[float]:
        """Age of a pod in seconds, or None when creation time is unavailable."""
        created = getattr(existing.metadata, "creation_timestamp", None)
        if created is None:
            return None
        return (datetime.now(timezone.utc) - created).total_seconds()

    def _is_pod_adoptable(self, existing) -> bool:
        """Only adopt a freshly created, not-yet-restored pod.

        Workspace restore runs on the backend after prepare returns, so a young
        pod created by a racing or gateway-timed-out prepare attempt has not been
        restored yet and is safe to reuse. An older pod may already carry a
        restored (and possibly modified) workspace; recreating it avoids running
        restore a second time over live changes.
        """
        if getattr(existing.metadata, "deletion_timestamp", None):
            return False
        phase = getattr(existing.status, "phase", None) if existing.status else None
        if phase not in ("Pending", "Running"):
            return False
        pod_age = self._pod_age_seconds(existing)
        if pod_age is None:
            return False
        max_age = max(float(os.getenv("EXECUTOR_ADOPT_MAX_AGE_SECONDS", "300")), 0.0)
        return pod_age <= max_age

    def _wait_pod_deleted(
        self, core_v1, namespace, pod_name, timeout_seconds=30, interval_seconds=1.0
    ) -> bool:
        """Poll until the named pod is gone (read returns 404)."""
        deadline = time.monotonic() + max(timeout_seconds, 0)
        while True:
            try:
                core_v1.read_namespaced_pod(name=pod_name, namespace=namespace)
            except ApiException as e:
                if e.status == HTTPStatus.NOT_FOUND:
                    return True
                logger.warning(
                    f"+++ Error while waiting for pod '{pod_name}' deletion: {e}"
                )
            if time.monotonic() >= deadline:
                return False
            time.sleep(interval_seconds)

    def _is_warmpool_sandbox_reusable(
        self, sandbox_status: Optional[Dict[str, Any]]
    ) -> bool:
        """Return whether an existing warm-pool sandbox has a usable Pod."""
        status = sandbox_status or {}
        return bool(
            status.get("exists")
            and status.get("phase") == "Running"
            and status.get("pod_name")
            and status.get("pod_ip")
        )

    def _handle_existing_warmpool_claim(
        self,
        warmpool_client,
        executor_name: str,
        task_id: str,
        template_name: str,
    ) -> Optional[Dict[str, Any]]:
        """Return a reusable sandbox status or delete a stale claim."""
        existing_claim = warmpool_client.get_sandbox_claim(executor_name)
        if not existing_claim:
            return None

        existing_template = (
            existing_claim.get("spec", {}).get("sandboxTemplateRef", {}).get("name")
        )
        if existing_template != template_name:
            logger.warning(
                "SandboxClaim '%s' uses template '%s', expected '%s'; recreating",
                executor_name,
                existing_template,
                template_name,
            )
            warmpool_client.delete_sandbox_claim(executor_name)
            return None

        logger.info(
            "SandboxClaim '%s' already exists for task %s, checking reusability",
            executor_name,
            task_id,
        )
        sandbox_status = warmpool_client.get_sandbox_status(executor_name)
        if self._is_warmpool_sandbox_reusable(sandbox_status):
            logger.info("Existing sandbox '%s' is running, reusing", executor_name)
            return sandbox_status

        if (sandbox_status or {}).get("phase") != "Running":
            sandbox_status = self._wait_for_warmpool_sandbox_ready(
                warmpool_client, executor_name, timeout=60
            )
            if self._is_warmpool_sandbox_reusable(sandbox_status or {}):
                return sandbox_status

        logger.warning(
            "Existing SandboxClaim '%s' is not reusable for task %s: "
            "phase=%s pod_name=%s pod_ip=%s; deleting before recreation",
            executor_name,
            task_id,
            (sandbox_status or {}).get("phase"),
            (sandbox_status or {}).get("pod_name"),
            (sandbox_status or {}).get("pod_ip"),
        )
        warmpool_client.delete_sandbox_claim(executor_name)
        return None

    def _create_pod_from_warmpool(
        self,
        task: Dict[str, Any],
        executor_name: str,
        user_name: str,
        task_id: str,
        subtask_id: str,  # noqa: ARG002 - kept for consistency with other methods
        template_name: Optional[str] = None,
        workload_type: str = "sandbox",
    ) -> Dict[str, Any]:
        """Claim a warm-pool pod for a sandbox or standard executor task.

        Args:
            task: Task information
            executor_name: Name for the executor
            user_name: User name
            task_id: Task ID
            subtask_id: Subtask ID
            template_name: SandboxTemplate name; defaults to the sandbox template
            workload_type: Either ``sandbox`` or ``executor``

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
            ANNOTATION_SKILL_IDENTITY_TOKEN,
            ANNOTATION_SKILL_USER_NAME,
            ANNOTATION_TASK_API_DOMAIN,
            LABEL_PROXY_USER,
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
        resolved_template_name = template_name or WARMPOOL_TEMPLATE_NAME
        is_git_executor = workload_type == "executor" and self._task_has_git_repository(
            task
        )
        expected_image = get_metadata_field(
            task, "executor_image", EXECUTOR_DEFAULT_MAGE
        )
        claim_labels = {}
        if workload_type == "executor":
            claim_labels = {
                LABEL_EXECUTOR: LABEL_EXECUTOR_VALUE,
                LABEL_TASK_ID: str(task_id),
                LABEL_POOL_STATE: "bound",
                LABEL_POOL_PROFILE: POOL_PROFILE_EXECUTOR_STANDARD,
            }

        try:
            if is_git_executor:
                try:
                    template = warmpool_client.get_sandbox_template(
                        resolved_template_name
                    )
                    template_reason = git_warmpool_runtime_ineligibility_reason(
                        self._task_git_url(task),
                        template or {},
                        expected_image,
                        is_template=True,
                    )
                except Exception as error:
                    logger.warning(
                        "Failed to inspect warm-pool template '%s' for Git task %s: %s",
                        resolved_template_name,
                        task_id,
                        error,
                    )
                    template_reason = "git_warmpool_capability_check_failed"
                if template_reason:
                    logger.warning(
                        "Git warm-pool template rejected for task %s: %s",
                        task_id,
                        template_reason,
                    )
                    self._discard_incompatible_warmpool_claim(
                        warmpool_client, executor_name, task_id
                    )
                    return {
                        "status": "fallback",
                        "fallback_reason": template_reason,
                    }

            sandbox_status = self._handle_existing_warmpool_claim(
                warmpool_client,
                executor_name,
                task_id,
                resolved_template_name,
            )
            if sandbox_status is None:
                # Claim metadata is not propagated to the Pod by the controller.
                # Patch task metadata after the claimed sandbox becomes ready.
                warmpool_client.create_sandbox_claim(
                    name=executor_name,
                    template_name=resolved_template_name,
                    labels=claim_labels,
                    annotations={},
                )

                logger.info(
                    "Created SandboxClaim '%s' for %s task %s with template '%s'",
                    executor_name,
                    workload_type,
                    task_id,
                    resolved_template_name,
                )

                sandbox_status = self._wait_for_warmpool_sandbox_ready(
                    warmpool_client, executor_name, timeout=60
                )

            if not sandbox_status:
                return {
                    "status": "failed",
                    "error_msg": "Sandbox pod did not become ready in time",
                }

            if claim_labels:
                # Claim labels are used by orphan cleanup even when its Pod is
                # temporarily missing. They intentionally contain no task secrets.
                warmpool_client.patch_sandbox_claim(
                    executor_name,
                    labels=claim_labels,
                )

            # Build labels and annotations for Pod (injected via patch after sandbox is ready)
            labels = {
                "app": executor_name,
                LABEL_EXECUTOR: LABEL_EXECUTOR_VALUE,
                LABEL_TASK_ID: str(task_id),
                LABEL_USER: user_name,
                LABEL_PROXY_USER: user_name,
                LABEL_TASK_TYPE: get_metadata_field(task, "type", "online"),
                LABEL_TEAM_MODE: get_metadata_field(task, "mode", "default"),
                LABEL_POOL_STATE: "bound",
            }
            if workload_type == "executor":
                labels[LABEL_POOL_PROFILE] = POOL_PROFILE_EXECUTOR_STANDARD
            annotations = {
                ANNOTATION_EMAIL: "weibo_ai_coding@weibo.com",
            }
            if workload_type == "sandbox":
                annotations.update(
                    {
                        ANNOTATION_HEARTBEAT_ENABLED: "true",
                        ANNOTATION_HEARTBEAT_TYPE: "sandbox",
                        ANNOTATION_HEARTBEAT_ID: str(task_id),
                    }
                )
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
                task_identity_env = build_task_identity_env(
                    skill_identity_token=get_metadata_field(
                        task, "skill_identity_token"
                    ),
                    user_name=user_name,
                )
                skill_identity_token = task_identity_env.get(
                    "WEGENT_SKILL_IDENTITY_TOKEN"
                )
                if skill_identity_token:
                    annotations[ANNOTATION_SKILL_IDENTITY_TOKEN] = skill_identity_token
                skill_user_name = task_identity_env.get("WEGENT_SKILL_USER_NAME")
                if skill_user_name:
                    annotations[ANNOTATION_SKILL_USER_NAME] = skill_user_name

            # Patch Pod labels and annotations with task-specific data
            pod_name = sandbox_status.get("pod_name")
            if is_git_executor:
                pod_reason = "git_warmpool_capability_check_failed"
                if pod_name:
                    try:
                        pod = warmpool_client.core_api.read_namespaced_pod(
                            name=pod_name,
                            namespace=K8S_NAMESPACE,
                        )
                        serialized_pod = serialize_k8s_resource(
                            warmpool_client.api_client, pod
                        )
                        pod_reason = git_warmpool_runtime_ineligibility_reason(
                            self._task_git_url(task),
                            serialized_pod,
                            expected_image,
                            is_template=False,
                        )
                    except Exception as error:
                        logger.warning(
                            "Failed to inspect claimed warm-pool Pod '%s' for Git task %s: %s",
                            pod_name,
                            task_id,
                            error,
                        )
                if pod_reason:
                    logger.warning(
                        "Claimed Git warm-pool Pod '%s' rejected for task %s: %s",
                        pod_name or "unknown",
                        task_id,
                        pod_reason,
                    )
                    self._discard_incompatible_warmpool_claim(
                        warmpool_client, executor_name, task_id
                    )
                    return {
                        "status": "fallback",
                        "fallback_reason": pod_reason,
                    }
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
                "Kubernetes API error claiming warm-pool %s for task %s: %s",
                workload_type,
                task_id,
                e,
            )
            return {"status": "failed", "error_msg": f"Kubernetes API error: {e}"}
        except Exception as e:
            logger.error(
                "Error claiming warm-pool %s for task %s: %s",
                workload_type,
                task_id,
                e,
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

    def delete_executor(
        self, pod_name: str, executor_namespace: Optional[str] = None
    ) -> Dict[str, Any]:
        try:
            claim_result = self._delete_warmpool_claim_for_executor(
                pod_name, executor_namespace
            )
            if claim_result:
                return claim_result

            core_v1 = self._get_core_v1_api()
            if core_v1 is None:
                return {
                    "status": "failed",
                    "error_msg": "Failed to get Kubernetes API client",
                }

            namespace = executor_namespace or K8S_NAMESPACE
            delete_options = client.V1DeleteOptions(propagation_policy="Background")
            core_v1.delete_namespaced_pod(
                name=pod_name, namespace=namespace, body=delete_options
            )
            logger.info(
                "Deleted Kubernetes pod '%s' in namespace '%s'", pod_name, namespace
            )
            return {"status": "success"}
        except ApiException as e:
            if e.status == HTTPStatus.NOT_FOUND:
                logger.warning(
                    "Pod '%s' not found in namespace %s",
                    pod_name,
                    executor_namespace or K8S_NAMESPACE,
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

    def _delete_warmpool_claim_for_executor(
        self, executor_name: str, executor_namespace: Optional[str]
    ) -> Optional[Dict[str, Any]]:
        """Delete the owning SandboxClaim before falling back to Pod deletion."""
        if executor_namespace and executor_namespace != K8S_NAMESPACE:
            return None

        claim_result = self.delete_sandbox_claim(executor_name)
        if claim_result.get("status") != "not_found":
            return claim_result

        core_v1 = self._get_core_v1_api()
        if core_v1 is None:
            return None

        try:
            pod = core_v1.read_namespaced_pod(
                name=executor_name,
                namespace=K8S_NAMESPACE,
            )
        except ApiException as e:
            if e.status == HTTPStatus.NOT_FOUND:
                return None
            return {
                "status": "failed",
                "error_msg": f"Kubernetes API error reading pod owner: {e}",
            }

        sandbox_name = self._sandbox_owner_name(pod.metadata)
        if not sandbox_name:
            return None

        logger.info(
            "Pod '%s' is owned by Sandbox '%s'; deleting its SandboxClaim",
            executor_name,
            sandbox_name,
        )
        owner_claim_result = self.delete_sandbox_claim(sandbox_name)
        if owner_claim_result.get("status") == "not_found":
            return None
        return owner_claim_result

    @staticmethod
    def _sandbox_owner_name(metadata: Any) -> Optional[str]:
        """Return the Sandbox owner name from Kubernetes object metadata."""
        if isinstance(metadata, dict):
            owner_references = metadata.get("ownerReferences") or []
        else:
            owner_references = getattr(metadata, "owner_references", None) or []

        for owner in owner_references:
            if isinstance(owner, dict):
                kind = owner.get("kind")
                name = owner.get("name")
                api_version = owner.get("apiVersion", "")
            else:
                kind = getattr(owner, "kind", None)
                name = getattr(owner, "name", None)
                api_version = getattr(owner, "api_version", "") or ""
            if (
                kind == SANDBOX_KIND
                and name
                and api_version.split("/", 1)[0] == SANDBOX_API_GROUP
            ):
                return str(name)
        return None

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
            if e.status == HTTPStatus.NOT_FOUND:
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

        First checks the Redis binding for a warm-pool SandboxClaim. If the
        binding is missing or stale, searches Pods by task label and resolves
        each Pod's Sandbox owner before falling back to direct Pod deletion.

        Args:
            task_id: Task ID to search for

        Returns:
            Dict with status and error_msg if failed
        """
        from executor_manager.services.sandbox.repository import get_sandbox_repository

        repository = None
        numeric_task_id = None
        try:
            repository = get_sandbox_repository()
            numeric_task_id = int(task_id)
            binding = repository.load_executor_binding_full(numeric_task_id)

            if binding and binding.get("sandbox_claim_name"):
                sandbox_claim_name = binding["sandbox_claim_name"]
                logger.info(
                    f"Found sandbox_claim_name '{sandbox_claim_name}' in binding for task {task_id}, "
                    "deleting SandboxClaim"
                )
                claim_result = self.delete_sandbox_claim(sandbox_claim_name)
                if claim_result.get("status") == "success":
                    repository.delete_executor_binding(numeric_task_id)
                    return claim_result
                if claim_result.get("status") != "not_found":
                    return claim_result
                logger.warning(
                    "SandboxClaim '%s' from task %s binding is missing; "
                    "falling back to Pod lookup",
                    sandbox_claim_name,
                    task_id,
                )
        except Exception as e:
            logger.debug(f"Error checking binding for task {task_id}: {e}")

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
                if repository is not None and numeric_task_id is not None:
                    repository.delete_executor_binding(numeric_task_id)
                logger.warning(
                    f"No pod found with task_id label '{task_id}' "
                    f"in namespace {K8S_NAMESPACE}"
                )
                return {
                    "status": "not_found",
                    "error_msg": f"No pod found with task_id '{task_id}'",
                }

            deleted_pods = []
            deletion_errors = []
            for pod in pods.items:
                pod_name = pod.metadata.name
                delete_result = self.delete_executor(pod_name, K8S_NAMESPACE)
                if delete_result.get("status") == "success":
                    deleted_pods.append(pod_name)
                    logger.info(
                        "Deleted executor runtime '%s' found by task_id label '%s'",
                        pod_name,
                        task_id,
                    )
                elif delete_result.get("status") != "not_found":
                    deletion_errors.append(
                        f"{pod_name}: {delete_result.get('error_msg', 'delete failed')}"
                    )

            if deleted_pods:
                if repository is not None and numeric_task_id is not None:
                    repository.delete_executor_binding(numeric_task_id)
                return {
                    "status": "success",
                    "deleted_pods": deleted_pods,
                }
            if deletion_errors:
                return {
                    "status": "failed",
                    "error_msg": "; ".join(deletion_errors),
                }
            if repository is not None and numeric_task_id is not None:
                repository.delete_executor_binding(numeric_task_id)
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
        """Get task_id from a direct Pod or logical warm-pool executor name.

        Args:
            executor_name: Direct Pod name or logical warm-pool executor name

        Returns:
            task_id string if found, None otherwise
        """
        try:
            core_v1 = self._get_core_v1_api()
            if core_v1 is None:
                return None

            try:
                pod = core_v1.read_namespaced_pod(
                    name=executor_name,
                    namespace=K8S_NAMESPACE,
                )
                if pod.metadata and pod.metadata.labels:
                    task_id = pod.metadata.labels.get(LABEL_TASK_ID)
                    if task_id:
                        return task_id
            except ApiException as e:
                if e.status != HTTPStatus.NOT_FOUND:
                    raise

            pods = core_v1.list_namespaced_pod(
                namespace=K8S_NAMESPACE,
                label_selector=(
                    f"{LABEL_EXECUTOR}={LABEL_EXECUTOR_VALUE},app={executor_name}"
                ),
            )
            for pod in pods.items:
                labels = pod.metadata.labels or {}
                task_id = labels.get(LABEL_TASK_ID)
                if task_id:
                    return task_id

            if WARMPOOL_ENABLED:
                from executor_manager.wecode.executors.warmpool import WarmPoolClient

                api_client = _get_api_client()
                if api_client is not None:
                    claim = WarmPoolClient(
                        api_client,
                        K8S_NAMESPACE,
                    ).get_sandbox_claim(executor_name)
                    labels = (claim or {}).get("metadata", {}).get("labels") or {}
                    return labels.get(LABEL_TASK_ID)
            return None
        except ApiException as e:
            if e.status != HTTPStatus.NOT_FOUND:
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

    @staticmethod
    def _compute_pod_display_status(pod: Dict[str, Any]) -> str:
        """Compute the STATUS value shown by ``kubectl get pods`` for a raw pod.

        Mirrors kubectl's printer logic for regular containers, including the
        multi-container "Completed"->Running/NotReady adjustment, so callers can
        tell a healthy ``Running`` pod apart from abnormal ones (``OOMKilled``,
        ``Error``, ``CrashLoopBackOff``, ``Evicted``, ``Terminating``, ...).
        Init-container states are not modelled (a pod stuck in init still reports
        a non-Running status, which is enough for abnormal-pod detection).

        Args:
            pod: Raw pod JSON as returned by the Kubernetes API.

        Returns:
            The display status string (e.g. "Running", "OOMKilled").
        """
        metadata = pod.get("metadata", {}) or {}
        status = pod.get("status", {}) or {}

        reason = status.get("phase", "") or ""
        if status.get("reason"):
            reason = status["reason"]

        # Regular container states override the phase; iterate in reverse like
        # kubectl so the first (lowest-index) container wins on a tie, while
        # tracking whether any container is still running.
        has_running = False
        for container_status in reversed(status.get("containerStatuses", []) or []):
            state = container_status.get("state", {}) or {}
            waiting = state.get("waiting") or {}
            terminated = state.get("terminated")
            if waiting.get("reason"):
                reason = waiting["reason"]
            elif terminated and terminated.get("reason"):
                reason = terminated["reason"]
            elif terminated:
                if terminated.get("signal"):
                    reason = f"Signal:{terminated['signal']}"
                else:
                    reason = f"ExitCode:{terminated.get('exitCode', 0)}"
            elif container_status.get("ready") and state.get("running") is not None:
                has_running = True

        # A container that Completed while another is still running is reported as
        # Running (or NotReady) by kubectl, so a healthy multi-container pod is not
        # misclassified as terminated.
        if reason == "Completed" and has_running:
            ready = any(
                cond.get("type") == "Ready" and cond.get("status") == "True"
                for cond in status.get("conditions", []) or []
            )
            reason = "Running" if ready else "NotReady"

        if metadata.get("deletionTimestamp"):
            reason = "Terminating"

        return reason

    def get_old_task_ids(self, older_than_hours: int = 48) -> Dict[str, Any]:
        """Get old executor runtimes for orphan cleanup.

        Includes normal executor Pods, bound warm-pool Pods, and labeled Executor
        SandboxClaims whose Pod is missing. Standby warm-pool capacity is excluded.

        Args:
            older_than_hours: Minimum pod age in hours.

        Returns:
            Dict with status and a ``pods`` compatibility list. ``pod_name`` is
            the cleanup target: a SandboxClaim name for warm-pool runtimes and
            the actual Pod name otherwise.
        """
        import re

        start_time = time.time()
        try:
            core_v1 = self._get_core_v1_api()
            if core_v1 is None:
                return {
                    "status": "failed",
                    "error_msg": "Failed to get Kubernetes API client",
                    "pods": [],
                }

            cutoff = datetime.now(timezone.utc) - timedelta(hours=older_than_hours)
            name_pattern = re.compile(r"wegent-task|sandbox")

            response = core_v1.list_namespaced_pod(
                namespace=K8S_NAMESPACE,
                _preload_content=False,
            )
            data = json.loads(response.data.decode("utf-8"))
            items = data.get("items", [])

            old_pods: List[Dict[str, Any]] = []
            cleanup_targets = set()
            for pod in items:
                metadata = pod.get("metadata", {})
                pod_name = metadata.get("name", "")
                labels = metadata.get("labels") or {}
                task_id = labels.get(LABEL_TASK_ID)
                is_bound_executor_claim = (
                    labels.get(LABEL_EXECUTOR) == LABEL_EXECUTOR_VALUE
                    and labels.get(LABEL_POOL_PROFILE) == POOL_PROFILE_EXECUTOR_STANDARD
                    and labels.get(LABEL_POOL_STATE) == "bound"
                    and bool(task_id)
                )
                if (
                    labels.get(LABEL_WARM_POOL) == "true"
                    and not is_bound_executor_claim
                ):
                    continue
                if not name_pattern.search(pod_name) and not is_bound_executor_claim:
                    continue
                if not self._is_resource_older_than(metadata, cutoff):
                    continue
                sandbox_name = self._sandbox_owner_name(metadata)
                cleanup_target = sandbox_name or pod_name
                old_pods.append(
                    {
                        "task_id": task_id,
                        "pod_name": cleanup_target,
                        "status": self._compute_pod_display_status(pod),
                    }
                )
                cleanup_targets.add(cleanup_target)

            old_pods.extend(
                self._get_old_executor_claim_targets(
                    core_v1,
                    cutoff,
                    cleanup_targets,
                )
            )

            elapsed = time.time() - start_time
            logger.info(
                "+++ Found %d old executor cleanup targets "
                "(older_than=%dh) in namespace %s (took %.2fs)",
                len(old_pods),
                older_than_hours,
                K8S_NAMESPACE,
                elapsed,
            )
            return {"status": "success", "pods": old_pods}

        except ApiException as e:
            logger.error("+++ Kubernetes API error listing old runtimes: %s", e)
            return {
                "status": "failed",
                "error_msg": f"Kubernetes API error: {e}",
                "pods": [],
            }
        except Exception as e:
            logger.error("+++ Error listing old Kubernetes runtimes: %s", e)
            return {"status": "failed", "error_msg": f"Error: {e}", "pods": []}

    @staticmethod
    def _is_resource_older_than(metadata: Dict[str, Any], cutoff: datetime) -> bool:
        """Return whether Kubernetes metadata has a valid timestamp before cutoff."""
        creation_timestamp = metadata.get("creationTimestamp")
        if not creation_timestamp:
            return False
        try:
            creation_time = datetime.fromisoformat(
                creation_timestamp.replace("Z", "+00:00")
            )
        except (ValueError, TypeError):
            return False
        return creation_time < cutoff

    def _get_old_executor_claim_targets(
        self,
        core_v1: client.CoreV1Api,
        cutoff: datetime,
        existing_targets: set,
    ) -> List[Dict[str, Any]]:
        """List old standard Executor claims not already represented by a Pod."""
        if not WARMPOOL_ENABLED:
            return []

        from executor_manager.wecode.executors.warmpool import WarmPoolClient

        warmpool_client = WarmPoolClient(core_v1.api_client, K8S_NAMESPACE)
        claim_selector = (
            f"{LABEL_EXECUTOR}={LABEL_EXECUTOR_VALUE},"
            f"{LABEL_POOL_PROFILE}={POOL_PROFILE_EXECUTOR_STANDARD}"
        )
        old_claims = []
        for claim in warmpool_client.list_sandbox_claims(claim_selector):
            metadata = claim.get("metadata") or {}
            claim_name = metadata.get("name", "")
            if (
                not claim_name
                or claim_name in existing_targets
                or not self._is_resource_older_than(metadata, cutoff)
            ):
                continue
            labels = metadata.get("labels") or {}
            old_claims.append(
                {
                    "task_id": labels.get(LABEL_TASK_ID),
                    "pod_name": claim_name,
                    # Empty status avoids treating a temporarily Pod-less claim
                    # as a dead Pod before backend activity checks.
                    "status": "",
                }
            )
        return old_claims

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

    def get_pod_owners_by_ip(self, ip_address: str) -> Dict[str, Any]:
        """Find Wegent executor Pods and owners by Pod IP."""
        core_v1 = self._get_core_v1_api()
        if core_v1 is None:
            return {
                "status": "failed",
                "error_msg": "Failed to get Kubernetes API client",
                "pods": [],
            }
        return lookup_pod_owners_by_ip(core_v1, K8S_NAMESPACE, ip_address)

    def get_pods_by_executor_name(
        self,
        executor_name: str,
        executor_namespace: Optional[str] = None,
    ) -> Dict[str, Any]:
        try:
            core_v1 = self._get_core_v1_api()
            if core_v1 is None:
                return {
                    "status": "failed",
                    "error_msg": "Failed to get Kubernetes API client",
                    "pods": [],
                }

            # Query related pods directly using executor name
            namespace = K8S_NAMESPACE or executor_namespace
            label_selector = f"aigc.weibo.com/executor=wegent,app={executor_name}"
            pods = core_v1.list_namespaced_pod(
                namespace=namespace, label_selector=label_selector
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
                f"Found {len(pod_list)} pods for executor '{executor_name}' in namespace {namespace}"
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

    def get_container_address(
        self,
        executor_name: str,
        executor_namespace: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Get container base URL for sandbox proxy.

        This method is called by SandboxManager to get the address for proxying
        requests to the sandbox container.

        Args:
            executor_name: Executor/Pod name
            executor_namespace: Executor namespace override when available

        Returns:
            Dict with status and base_url (e.g., http://10.0.0.1:8080)
        """
        pod_result = self.get_pods_by_executor_name(
            executor_name,
            executor_namespace=executor_namespace,
        )
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
            if e.status == HTTPStatus.NOT_FOUND:
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

    def cancel_task(
        self, task_id: int, subtask_id: Optional[int] = None
    ) -> Dict[str, Any]:
        """
        Cancel a running task by calling the executor's cancel API.

        Args:
            task_id (int): Task ID to cancel.
            subtask_id (Optional[int]): Subtask ID to cancel.

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
            if subtask_id is not None:
                cancel_url += f"&subtask_id={subtask_id}"
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

    def _send_failure_callback(
        self,
        task_id: str,
        subtask_id: str,
        executor_name: Optional[str],
        error_message: str,
    ) -> None:
        """Push a FAILED status callback to the backend for regular/subagent tasks.

        Called when pod creation or initial task dispatch fails so the frontend
        is immediately updated instead of staying stuck in a "processing" state.

        Args:
            task_id: Task ID
            subtask_id: Subtask ID
            executor_name: Pod/executor name (may be None if pod was never created)
            error_message: Human-readable error description
        """
        try:
            from executor_manager.clients.callback_client import get_callback_client

            cb_client = get_callback_client()

            # Create a new event loop to avoid conflicts with existing loops
            # This prevents "RuntimeError: This event loop is already running"
            # when called from async contexts (e.g., FastAPI routes, APScheduler)
            loop = asyncio.new_event_loop()
            try:
                loop.run_until_complete(
                    cb_client.send_error(
                        task_id=int(task_id),
                        subtask_id=int(subtask_id),
                        error_message=error_message,
                        executor_name=executor_name,
                        error_code="dispatch_failed",
                    )
                )
            finally:
                loop.close()

            logger.info(
                f"Sent dispatch failure callback for task {task_id}/{subtask_id}"
            )
        except Exception as e:
            logger.error(
                f"Failed to send dispatch failure callback for task {task_id}: {e}"
            )
