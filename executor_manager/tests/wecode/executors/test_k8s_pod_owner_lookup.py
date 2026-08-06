# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from types import SimpleNamespace

from executor_manager.wecode.executors.k8s.pod_lookup import (
    lookup_pod_owners_by_ip,
)


def test_lookup_pod_owners_by_ip_returns_labeled_wegent_pods(mocker):
    core_v1 = mocker.MagicMock()
    core_v1.list_namespaced_pod.return_value = SimpleNamespace(
        items=[
            SimpleNamespace(
                metadata=SimpleNamespace(
                    name="wegent-task-alice-abc",
                    namespace="wb-plat-ide",
                    labels={
                        "aigc.weibo.com/user": "alice",
                        "aigc.weibo.com/executor-task-id": "1234",
                    },
                ),
                status=SimpleNamespace(pod_ip="10.0.0.8", phase="Running"),
            )
        ]
    )

    result = lookup_pod_owners_by_ip(core_v1, "wb-plat-ide", "10.0.0.8")

    assert result == {
        "status": "success",
        "pods": [
            {
                "pod_name": "wegent-task-alice-abc",
                "namespace": "wb-plat-ide",
                "pod_ip": "10.0.0.8",
                "phase": "Running",
                "user_name": "alice",
                "task_id": "1234",
            }
        ],
    }
    core_v1.list_namespaced_pod.assert_called_once_with(
        namespace="wb-plat-ide",
        label_selector="aigc.weibo.com/executor=wegent",
        field_selector="status.podIP=10.0.0.8",
    )


def test_lookup_pod_owners_by_ip_ignores_pods_without_owner_label(mocker):
    core_v1 = mocker.MagicMock()
    core_v1.list_namespaced_pod.return_value = SimpleNamespace(
        items=[
            SimpleNamespace(
                metadata=SimpleNamespace(
                    name="warm-pool-standby",
                    namespace="wb-plat-ide",
                    labels={},
                ),
                status=SimpleNamespace(pod_ip="10.0.0.9", phase="Running"),
            )
        ]
    )

    result = lookup_pod_owners_by_ip(core_v1, "wb-plat-ide", "10.0.0.9")

    assert result == {"status": "success", "pods": []}
