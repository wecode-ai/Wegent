# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from types import SimpleNamespace

from executor_manager.wecode.executors.k8s.k8s_executor import (
    K8S_NAMESPACE,
    K8sExecutor,
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
