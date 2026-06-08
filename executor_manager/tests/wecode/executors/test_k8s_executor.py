# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import sys
from types import ModuleType, SimpleNamespace

from executor_manager.wecode.executors.k8s.build_pod import build_pod_configuration
from executor_manager.wecode.executors.k8s.k8s_executor import (
    K8S_NAMESPACE,
    K8sExecutor,
)
from executor_manager.wecode.executors.warmpool.constants import (
    ANNOTATION_SKILL_IDENTITY_TOKEN,
    ANNOTATION_SKILL_USER_NAME,
)


def test_get_pods_by_executor_name_prefers_k8s_namespace(mocker):
    executor = object.__new__(K8sExecutor)
    core_v1 = mocker.MagicMock()
    core_v1.list_namespaced_pod.return_value = SimpleNamespace(
        items=[
            SimpleNamespace(
                metadata=SimpleNamespace(name="executor-1", creation_timestamp="now"),
                status=SimpleNamespace(pod_ip="10.0.0.8", phase="Running"),
            )
        ]
    )
    mocker.patch.object(executor, "_get_core_v1_api", return_value=core_v1)

    result = executor.get_pods_by_executor_name(
        "executor-1", executor_namespace="custom-ns"
    )

    assert result == {
        "status": "success",
        "pods": [
            {
                "name": "executor-1",
                "ip": "10.0.0.8",
                "status": "Running",
                "creation_timestamp": "now",
            }
        ],
    }
    core_v1.list_namespaced_pod.assert_called_once_with(
        namespace=K8S_NAMESPACE,
        label_selector="aigc.weibo.com/executor=wegent,app=executor-1",
    )


def test_get_container_address_forwards_executor_namespace(mocker):
    executor = object.__new__(K8sExecutor)
    get_pods_by_executor_name = mocker.patch.object(
        executor,
        "get_pods_by_executor_name",
        return_value={
            "status": "success",
            "pods": [
                {
                    "name": "executor-1",
                    "ip": "10.0.0.8",
                    "status": "Running",
                    "creation_timestamp": "now",
                }
            ],
        },
    )

    result = executor.get_container_address(
        "executor-1", executor_namespace="custom-ns"
    )

    assert result == {
        "status": "success",
        "base_url": "http://10.0.0.8:8080",
    }
    get_pods_by_executor_name.assert_called_once_with(
        "executor-1", executor_namespace="custom-ns"
    )


def test_delete_executor_prefers_explicit_executor_namespace(mocker):
    executor = object.__new__(K8sExecutor)
    core_v1 = mocker.MagicMock()
    mocker.patch.object(executor, "_get_core_v1_api", return_value=core_v1)

    result = executor.delete_executor("executor-1", executor_namespace="custom-ns")

    assert result == {"status": "success"}
    core_v1.delete_namespaced_pod.assert_called_once()
    _, kwargs = core_v1.delete_namespaced_pod.call_args
    assert kwargs["name"] == "executor-1"
    assert kwargs["namespace"] == "custom-ns"


def test_submit_executor_prepare_only_skips_initial_dispatch(mocker):
    executor = object.__new__(K8sExecutor)
    prepare_task = {
        "task_id": 123,
        "subtask_id": 456,
        "user": {"name": "test_user"},
        "type": "online",
        "prepare_only": True,
    }

    mocker.patch.object(executor, "get_user_pods", return_value=0)
    mocker.patch.object(executor, "get_user_max_tasks", return_value=5)
    mock_create_instance = mocker.patch.object(executor, "create_instance")
    mock_wait_ready = mocker.patch.object(executor, "wait_instance_ready")
    mock_dispatch = mocker.patch.object(executor, "dispatch_task_to_instance")
    mock_register = mocker.patch.object(executor, "register_task_for_heartbeat")

    result = executor.submit_executor(prepare_task)

    assert result["status"] == "success"
    assert result["executor_name"]
    mock_create_instance.assert_called_once()
    mock_wait_ready.assert_called_once_with(result["executor_name"])
    mock_dispatch.assert_not_called()
    mock_register.assert_called_once()


def test_build_pod_configuration_includes_skill_identity_env():
    task = {
        "task_id": 123,
        "subtask_id": 456,
        "user": {"name": "test_user"},
        "type": "sandbox",
        "skill_identity_token": "skill-jwt",
        "sandbox_metadata": {"sandbox_id": "123"},
    }

    pod = build_pod_configuration(
        "test_user",
        "executor-1",
        "test-ns",
        task,
        "test/executor:latest",
        123,
        "default",
    )

    env = {
        item["name"]: item.get("value")
        for item in pod["spec"]["containers"][0]["env"]
        if "name" in item
    }
    assert env["WEGENT_SKILL_IDENTITY_TOKEN"] == "skill-jwt"
    assert env["WEGENT_SKILL_USER_NAME"] == "test_user"


def test_create_pod_from_warmpool_patches_skill_identity_annotations(mocker):
    executor = object.__new__(K8sExecutor)
    mocker.patch(
        "executor_manager.wecode.executors.k8s.k8s_executor._get_api_client",
        return_value=object(),
    )

    warm_pool_client = mocker.MagicMock()
    warm_pool_client.get_sandbox_claim.return_value = None
    mocker.patch(
        "executor_manager.wecode.executors.warmpool.WarmPoolClient",
        return_value=warm_pool_client,
    )
    mocker.patch.object(
        executor,
        "_wait_for_warmpool_sandbox_ready",
        return_value={"pod_name": "pod-1"},
    )
    repository = mocker.MagicMock()
    sandbox_package = ModuleType("executor_manager.services.sandbox")
    sandbox_package.__path__ = []
    repository_module = ModuleType("executor_manager.services.sandbox.repository")
    repository_module.get_sandbox_repository = mocker.MagicMock(return_value=repository)
    mocker.patch.dict(
        sys.modules,
        {
            "executor_manager.services.sandbox": sandbox_package,
            "executor_manager.services.sandbox.repository": repository_module,
        },
    )

    result = executor._create_pod_from_warmpool(
        task={
            "task_id": 123,
            "type": "sandbox",
            "skill_identity_token": "skill-jwt",
        },
        executor_name="executor-1",
        user_name="test_user",
        task_id="123",
        subtask_id="456",
    )

    assert result == {"status": "success"}
    warm_pool_client.patch_pod_metadata.assert_called_once()
    annotations = warm_pool_client.patch_pod_metadata.call_args.kwargs["annotations"]
    assert annotations[ANNOTATION_SKILL_IDENTITY_TOKEN] == "skill-jwt"
    assert annotations[ANNOTATION_SKILL_USER_NAME] == "test_user"
