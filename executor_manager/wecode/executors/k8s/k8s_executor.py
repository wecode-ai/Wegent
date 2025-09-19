import hashlib
import json
import os
import re
import uuid
import yaml
from typing import Any, Dict, Optional

import requests

from executor_manager.executors.docker.constants import (
    DEFAULT_API_ENDPOINT,
    DEFAULT_PROGRESS_COMPLETE,
)
from executor_manager.utils.executor_name import generate_executor_name
from executor_manager.wecode.config.config import (
    EXECUTOR_DEFAULT_MAGE,
    K8S_NAMESPACE,
    MAX_USER_TASKS,
)
from executor_manager.wecode.executors.k8s.build_pod import build_pod_configuration
from kubernetes import client, config
from kubernetes.client.rest import ApiException

from shared.logger import setup_logger
from shared.status import TaskStatus

from executor_manager.executors.base import Executor

logger = setup_logger(__name__)


# 加载 Kubernetes 配置
def _load_k8s_config() -> client.ApiClient:
    try:
        config.load_incluster_config()
        logger.info("Loaded in-cluster Kubernetes configuration")

        configuration = client.Configuration.get_default_copy()
        configuration.verify_ssl = False  # ❗只建议调试或内部环境使用
        return client.ApiClient(configuration)

    except config.ConfigException:
        try:
            config.load_kube_config()
            logger.info("Loaded kubeconfig file")

            configuration = client.Configuration.get_default_copy()
            configuration.verify_ssl = False
            return client.ApiClient(configuration)

        except config.ConfigException as e:
            logger.error(f"Could not configure Kubernetes client: {e}")
            return None


class K8sExecutor(Executor):
    def __init__(self):
        self.api_client = _load_k8s_config()
        if self.api_client is None:
            raise RuntimeError("Failed to configure Kubernetes client")

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

        task_str = json.dumps(task)

        status = "success"
        progress = 30
        error_msg = ""
        callback_status = TaskStatus.RUNNING.value

        if task.get("executor_name"):
            pod_result = self.get_pods_by_executor_name(task.get("executor_name"))
            pod_list = pod_result.get("pods", [])
            logger.info(pod_list)
            if len(pod_list) > 0:
                ip = pod_list[0].get("ip")
                response = self._send_task_to_container(task=task, host=ip, port=8080)
                if response.json()["status"] == TaskStatus.FAILED.value:
                    status = "failed"
                    progress = 100
                    error_msg = response.json().get("error_msg", "")
                    callback_status = TaskStatus.FAILED.value
            else:
                status = "failed"
                progress = 100
                error_msg = "Agent is deleted. Please new task and submit it again."
                callback_status = TaskStatus.FAILED.value
        else:
            # 根据executor_name 查询一下 是否有pod存在, 如果存在则直接使用 http 接口发起任务
            try:
                executor_name = generate_executor_name(task_id, subtask_id, user_name)

                user_pod_count = self.get_user_pods(user_name=user_name)
                logger.info(f"User {user_name} has {user_pod_count} pods.")
                if user_pod_count >= MAX_USER_TASKS:
                    logger.info(f"User {user_name} has reached the pod limit.")
                    status = "failed"
                    progress = 100
                    error_msg = (
                        "User has reached the pod limit. Please delete history tasks."
                    )
                    callback_status = TaskStatus.FAILED.value
                else:
                    pod = build_pod_configuration(
                        user_name,
                        executor_name,
                        K8S_NAMESPACE,
                        task_str,
                        image,
                        task_id,
                        task.get("mode", "default"),
                    )
                    pod_result = self._submit_kubernetes_pod(
                        pod, K8S_NAMESPACE, executor_name, task_id
                    )
                    if not pod_result or pod_result.get("status") != "success":
                        logger.error(
                            f"Kubernetes pod creation failed for task {task_id}: {pod_result.get('error_msg', '')}"
                        )
                        status = "failed"
                        progress = 100
                        error_msg = pod_result.get(
                            "error_msg", "Kubernetes pod creation failed"
                        )
                        callback_status = TaskStatus.FAILED.value
            except ApiException as e:
                logger.error(
                    f"Kubernetes API error creating pod for task {task_id}: {e}"
                )
                status = "failed"
                progress = 100
                error_msg = f"Kubernetes API error: {e}"
                callback_status = TaskStatus.FAILED.value
            except Exception as e:
                logger.error(f"Error creating Kubernetes pod for task {task_id}: {e}")
                status = "failed"
                progress = 100
                error_msg = f"Error: {e}"
                callback_status = TaskStatus.FAILED.value

        if callback:
            try:
                callback(
                    task_id=task_id,
                    subtask_id=subtask_id,
                    executor_name=executor_name,
                    progress=progress,
                    executor_namespace=K8S_NAMESPACE,
                    status=callback_status,
                    error_message=error_msg,
                )
            except Exception as e:
                logger.error(f"Error in callback for task {task_id}: {e}")

        if status == "success":
            return {"status": "success", "pod_name": executor_name}
        else:
            return {
                "status": "failed",
                "error_msg": error_msg,
                "pod_name": executor_name,
            }

    def _send_task_to_container(
        self, task: Dict[str, Any], host: str, port: int
    ) -> requests.Response:
        """发送任务到容器的API端点"""
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
        core_v1 = client.CoreV1Api(self.api_client)
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
            core_v1 = client.CoreV1Api(self.api_client)
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

    def get_current_task_ids(
        self, label_selector: Optional[str] = None
    ) -> Dict[str, Any]:
        try:
            # 如果没有提供标签选择器，则使用默认的标签选择器
            if label_selector is None:
                label_selector = "aigc.weibo.com/executor=wegent"
            else:
                label_selector = f"{label_selector},aigc.weibo.com/executor=wegent"

            core_v1 = client.CoreV1Api(self.api_client)
            pods = core_v1.list_namespaced_pod(
                namespace=K8S_NAMESPACE, label_selector=label_selector
            )

            task_ids = []
            for pod in pods.items:
                # 从 pod 的标签中提取任务 ID，使用正确的标签名称
                if (
                    pod.metadata.labels
                    and "aigc.weibo.com/executor-task-id" in pod.metadata.labels
                ):
                    task_ids.append(
                        pod.metadata.labels["aigc.weibo.com/executor-task-id"]
                    )
                # 如果没有明确的任务 ID 标签，可以尝试从 pod 名称中提取
                else:
                    pod_name = pod.metadata.name
                    # 假设任务 ID 可能包含在 pod 名称中
                    match = re.search(r"wegent-task-[^-]+-(\d+)-", pod_name)
                    if match:
                        task_ids.append(match.group(1))

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
        try:
            core_v1 = client.CoreV1Api(self.api_client)
            pods = core_v1.list_namespaced_pod(
                namespace=K8S_NAMESPACE, label_selector=label_selector
            )
            logger.info(f"Found {len(pods.items)} pods in namespace {K8S_NAMESPACE}")
            return {"status": "success", "running": len(pods.items)}
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
            core_v1 = client.CoreV1Api(self.api_client)
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
        """
        根据Kubernetes executor名称查询相关的Pod

        Args:
            executor_name (str): Kubernetes executor名称

        Returns:
            Dict[str, Any]: {
                "status": "success" 或 "failed",
                "pods": [pod信息列表] (如果成功),
                "error_msg": 错误信息 (如果失败)
            }
        """
        try:
            core_v1 = client.CoreV1Api(self.api_client)
            # 使用executor名称直接查询相关的Pod
            label_selector = f"aigc.weibo.com/executor-name={executor_name}"
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
