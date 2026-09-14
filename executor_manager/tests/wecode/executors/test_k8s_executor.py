# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import importlib
import json
import sys
from datetime import datetime, timedelta, timezone
from types import ModuleType, SimpleNamespace

from kubernetes.client.rest import ApiException

from executor_manager.wecode.executors.k8s.build_pod import build_pod_configuration
from executor_manager.wecode.executors.k8s.git_warmpool import (
    runtime_ineligibility_reason as git_warmpool_runtime_ineligibility_reason,
)
from executor_manager.wecode.executors.k8s.k8s_executor import (
    K8S_NAMESPACE,
    K8sExecutor,
)
from executor_manager.wecode.executors.warmpool.constants import (
    ANNOTATION_AUTH_TOKEN,
    ANNOTATION_HEARTBEAT_ID,
    ANNOTATION_SKILL_IDENTITY_TOKEN,
    ANNOTATION_SKILL_USER_NAME,
    LABEL_EXECUTOR,
    LABEL_EXECUTOR_VALUE,
    LABEL_POOL_PROFILE,
    LABEL_POOL_STATE,
    LABEL_TASK_ID,
    LABEL_WARM_POOL,
    POOL_PROFILE_EXECUTOR_STANDARD,
)
from executor_manager.wecode.executors.warmpool.template_builder import (
    build_warm_pool_pod_config,
)


def test_cancel_task_forwards_subtask_id_to_executor(mocker):
    executor = object.__new__(K8sExecutor)
    executor.requests = mocker.MagicMock()
    response = mocker.MagicMock()
    executor.requests.post.return_value = response

    core_v1 = mocker.MagicMock()
    core_v1.list_namespaced_pod.return_value = SimpleNamespace(
        items=[
            SimpleNamespace(
                metadata=SimpleNamespace(name="executor-1"),
                status=SimpleNamespace(pod_ip="10.0.0.8"),
            )
        ]
    )
    mocker.patch.object(executor, "_get_core_v1_api", return_value=core_v1)

    result = executor.cancel_task(316109593137557, 316109593137560)

    assert result["status"] == "success"
    executor.requests.post.assert_called_once_with(
        "http://10.0.0.8:8080/api/tasks/cancel"
        "?task_id=316109593137557&subtask_id=316109593137560",
        timeout=10,
    )
    response.raise_for_status.assert_called_once_with()


def test_warm_pool_template_uses_dynamic_runtime_binding_metadata():
    pod = build_warm_pool_pod_config(
        executor_name="warmpool-test",
        executor_image="executor:test",
        namespace="test-ns",
    )
    container = pod["spec"]["containers"][0]
    env = {item["name"]: item.get("value") for item in container["env"]}

    assert env["WARM_POOL_MODE"] == "true"
    assert env["HEARTBEAT_ENABLED"] == "true"
    assert "EXECUTOR_MANAGER_HEARTBEAT_BASE_URL" in env
    assert "HEARTBEAT_TYPE" not in env

    annotations = pod["metadata"]["annotations"]
    assert annotations[ANNOTATION_AUTH_TOKEN] == ""
    assert annotations[ANNOTATION_HEARTBEAT_ID] == ""
    assert ANNOTATION_AUTH_TOKEN not in pod["metadata"]["labels"]
    assert ANNOTATION_HEARTBEAT_ID not in pod["metadata"]["labels"]

    config_volume = next(
        volume for volume in pod["spec"]["volumes"] if volume["name"] == "wegent-config"
    )
    field_paths = {
        item["path"]: item["fieldRef"]["fieldPath"]
        for item in config_volume["downwardAPI"]["items"]
    }
    assert field_paths["auth_token"] == (
        "metadata.annotations['aigc.weibo.com/auth-token']"
    )
    assert field_paths["callback_url"] == (
        "metadata.annotations['aigc.weibo.com/callback-url']"
    )
    assert field_paths["heartbeat_id"] == (
        "metadata.annotations['aigc.weibo.com/heartbeat-id']"
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


def test_get_pod_owners_by_ip_uses_configured_namespace(mocker):
    executor = object.__new__(K8sExecutor)
    core_v1 = mocker.MagicMock()
    mocker.patch.object(executor, "_get_core_v1_api", return_value=core_v1)
    lookup = mocker.patch(
        "executor_manager.wecode.executors.k8s.k8s_executor.lookup_pod_owners_by_ip",
        return_value={"status": "success", "pods": []},
    )

    result = executor.get_pod_owners_by_ip("10.0.0.8")

    assert result == {"status": "success", "pods": []}
    lookup.assert_called_once_with(core_v1, K8S_NAMESPACE, "10.0.0.8")


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


def test_get_executor_task_id_resolves_logical_warmpool_executor(mocker):
    executor = object.__new__(K8sExecutor)
    core_v1 = mocker.MagicMock()
    core_v1.read_namespaced_pod.side_effect = ApiException(status=404)
    core_v1.list_namespaced_pod.return_value = SimpleNamespace(
        items=[SimpleNamespace(metadata=SimpleNamespace(labels={LABEL_TASK_ID: "123"}))]
    )
    mocker.patch.object(executor, "_get_core_v1_api", return_value=core_v1)

    task_id = executor.get_executor_task_id("executor-claim-1")

    assert task_id == "123"
    core_v1.list_namespaced_pod.assert_called_once_with(
        namespace=K8S_NAMESPACE,
        label_selector=(
            f"{LABEL_EXECUTOR}={LABEL_EXECUTOR_VALUE},app=executor-claim-1"
        ),
    )


def test_get_executor_task_id_resolves_claim_without_pod(mocker):
    executor = object.__new__(K8sExecutor)
    mocker.patch(
        "executor_manager.wecode.executors.k8s.k8s_executor.WARMPOOL_ENABLED",
        True,
    )
    core_v1 = mocker.MagicMock()
    core_v1.read_namespaced_pod.side_effect = ApiException(status=404)
    core_v1.list_namespaced_pod.return_value = SimpleNamespace(items=[])
    mocker.patch.object(executor, "_get_core_v1_api", return_value=core_v1)
    mocker.patch(
        "executor_manager.wecode.executors.k8s.k8s_executor._get_api_client",
        return_value=object(),
    )
    warm_pool_client = mocker.MagicMock()
    warm_pool_client.get_sandbox_claim.return_value = {
        "metadata": {"labels": {LABEL_TASK_ID: "123"}}
    }
    mocker.patch(
        "executor_manager.wecode.executors.warmpool.WarmPoolClient",
        return_value=warm_pool_client,
    )

    task_id = executor.get_executor_task_id("executor-claim-1")

    assert task_id == "123"
    warm_pool_client.get_sandbox_claim.assert_called_once_with("executor-claim-1")


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


def test_delete_executor_deletes_same_name_sandbox_claim_first(mocker):
    executor = object.__new__(K8sExecutor)
    core_v1 = mocker.MagicMock()
    mocker.patch.object(executor, "_get_core_v1_api", return_value=core_v1)
    delete_sandbox_claim = mocker.patch.object(
        executor,
        "delete_sandbox_claim",
        return_value={"status": "success"},
    )

    result = executor.delete_executor("executor-1")

    assert result == {"status": "success"}
    delete_sandbox_claim.assert_called_once_with("executor-1")
    core_v1.delete_namespaced_pod.assert_not_called()


def test_delete_executor_deletes_pod_when_sandbox_claim_missing(mocker):
    executor = object.__new__(K8sExecutor)
    core_v1 = mocker.MagicMock()
    mocker.patch.object(executor, "_get_core_v1_api", return_value=core_v1)
    mocker.patch.object(
        executor,
        "delete_sandbox_claim",
        return_value={"status": "not_found"},
    )

    result = executor.delete_executor("executor-1")

    assert result == {"status": "success"}
    core_v1.delete_namespaced_pod.assert_called_once()


def test_delete_executor_resolves_sandbox_claim_from_pod_owner(mocker):
    executor = object.__new__(K8sExecutor)
    core_v1 = mocker.MagicMock()
    core_v1.read_namespaced_pod.return_value = SimpleNamespace(
        metadata=SimpleNamespace(
            owner_references=[
                SimpleNamespace(
                    api_version="agents.x-k8s.io/v1alpha1",
                    kind="Sandbox",
                    name="executor-claim-1",
                )
            ]
        )
    )
    mocker.patch.object(executor, "_get_core_v1_api", return_value=core_v1)
    delete_sandbox_claim = mocker.patch.object(
        executor,
        "delete_sandbox_claim",
        side_effect=[{"status": "not_found"}, {"status": "success"}],
    )

    result = executor.delete_executor("warmpool-pod-abc")

    assert result == {"status": "success"}
    assert delete_sandbox_claim.call_args_list == [
        mocker.call("warmpool-pod-abc"),
        mocker.call("executor-claim-1"),
    ]
    core_v1.delete_namespaced_pod.assert_not_called()


def test_delete_executor_returns_not_found_when_claim_and_pod_missing(mocker):
    executor = object.__new__(K8sExecutor)
    core_v1 = mocker.MagicMock()
    core_v1.delete_namespaced_pod.side_effect = ApiException(status=404)
    mocker.patch.object(executor, "_get_core_v1_api", return_value=core_v1)
    delete_sandbox_claim = mocker.patch.object(
        executor,
        "delete_sandbox_claim",
        return_value={"status": "not_found"},
    )

    result = executor.delete_executor("executor-1")

    assert result == {"status": "not_found", "error_msg": "Pod 'executor-1' not found"}
    delete_sandbox_claim.assert_called_once_with("executor-1")


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
    mock_register.assert_not_called()


def test_submit_executor_attaches_executor_info_before_initial_dispatch(mocker):
    executor = object.__new__(K8sExecutor)
    task = {
        "task_id": 123,
        "subtask_id": 456,
        "user": {"name": "test_user"},
        "type": "online",
        "metadata": {},
    }

    mocker.patch.object(executor, "get_user_pods", return_value=0)
    mocker.patch.object(executor, "get_user_max_tasks", return_value=5)
    mocker.patch.object(executor, "create_instance")
    mocker.patch.object(
        executor,
        "wait_instance_ready",
        return_value={"host": "10.0.0.8", "port": 8080},
    )
    dispatch = mocker.patch.object(
        executor, "dispatch_task_to_instance", return_value={"error_msg": ""}
    )
    mocker.patch.object(executor, "register_task_for_heartbeat")

    result = executor.submit_executor(task)

    assert result["status"] == "success"
    dispatched_task = dispatch.call_args.args[0]
    assert dispatched_task["metadata"]["executor_name"] == result["executor_name"]
    assert dispatched_task["metadata"]["executor_namespace"] == K8S_NAMESPACE


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


def test_build_pod_configuration_sources_executor_secret_env():
    task = {
        "task_id": 123,
        "subtask_id": 456,
        "user": {"name": "test_user"},
        "type": "online",
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

    container = pod["spec"]["containers"][0]
    assert container["command"] == ["/bin/sh", "-c"]
    assert "set -a" in container["args"][0]
    assert ". /etc/wegent-executor-secret/env" in container["args"][0]
    assert "exec /app/executor" in container["args"][0]
    assert {
        "name": "wegent-executor-secret",
        "mountPath": "/etc/wegent-executor-secret",
        "readOnly": True,
    } in container["volumeMounts"]
    assert {
        "name": "wegent-executor-secret",
        "secret": {"secretName": "wegent-executor-secret"},
    } in pod["spec"]["volumes"]


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
    labels = warm_pool_client.patch_pod_metadata.call_args.kwargs["labels"]
    assert labels[LABEL_POOL_STATE] == "bound"
    assert annotations[ANNOTATION_SKILL_IDENTITY_TOKEN] == "skill-jwt"
    assert annotations[ANNOTATION_SKILL_USER_NAME] == "test_user"


def test_create_pod_from_warmpool_deletes_stale_claim_without_pod(mocker):
    executor = object.__new__(K8sExecutor)
    mocker.patch(
        "executor_manager.wecode.executors.k8s.k8s_executor._get_api_client",
        return_value=object(),
    )

    warm_pool_client = mocker.MagicMock()
    warm_pool_client.get_sandbox_claim.return_value = {
        "metadata": {"name": "executor-1"}
    }
    warm_pool_client.get_sandbox_status.return_value = {
        "exists": True,
        "phase": "Running",
        "pod_name": "missing-pod",
        "pod_ip": None,
    }
    mocker.patch(
        "executor_manager.wecode.executors.warmpool.WarmPoolClient",
        return_value=warm_pool_client,
    )
    mocker.patch.object(
        executor,
        "_wait_for_warmpool_sandbox_ready",
        return_value={"pod_name": "pod-1", "pod_ip": "10.0.0.8"},
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
        task={"task_id": 123, "type": "sandbox"},
        executor_name="executor-1",
        user_name="test_user",
        task_id="123",
        subtask_id="456",
    )

    assert result == {"status": "success"}
    warm_pool_client.delete_sandbox_claim.assert_called_once_with("executor-1")
    warm_pool_client.create_sandbox_claim.assert_called_once()


def test_create_executor_from_warmpool_omits_task_secrets_from_metadata(mocker):
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
            "type": "online",
            "auth_token": "task-jwt",
            "skill_identity_token": "skill-jwt",
            "git_auth_transport": "encrypted_request_token",
            "user": {
                "git_domain": "github.com",
                "git_token": "iOuoSwc/HrF6ZhttvtSNeQ==",
            },
        },
        executor_name="executor-1",
        user_name="test_user",
        task_id="123",
        subtask_id="456",
        template_name="wegent-executor-standard-1.0.214",
        workload_type="executor",
    )

    assert result == {"status": "success"}
    assert (
        warm_pool_client.create_sandbox_claim.call_args.kwargs["template_name"]
        == "wegent-executor-standard-1.0.214"
    )
    claim_labels = warm_pool_client.create_sandbox_claim.call_args.kwargs["labels"]
    assert claim_labels == {
        LABEL_EXECUTOR: LABEL_EXECUTOR_VALUE,
        LABEL_TASK_ID: "123",
        LABEL_POOL_STATE: "bound",
        LABEL_POOL_PROFILE: POOL_PROFILE_EXECUTOR_STANDARD,
    }
    warm_pool_client.patch_sandbox_claim.assert_called_once_with(
        "executor-1",
        labels=claim_labels,
    )
    pod_labels = warm_pool_client.patch_pod_metadata.call_args.kwargs["labels"]
    assert pod_labels[LABEL_POOL_PROFILE] == POOL_PROFILE_EXECUTOR_STANDARD
    assert pod_labels[LABEL_POOL_STATE] == "bound"
    annotations = warm_pool_client.patch_pod_metadata.call_args.kwargs["annotations"]
    assert ANNOTATION_AUTH_TOKEN not in annotations
    assert ANNOTATION_SKILL_IDENTITY_TOKEN not in annotations
    assert ANNOTATION_SKILL_USER_NAME not in annotations
    assert ANNOTATION_HEARTBEAT_ID not in annotations
    metadata_calls = json.dumps(
        {
            "create": warm_pool_client.create_sandbox_claim.call_args.kwargs,
            "claim_patch": warm_pool_client.patch_sandbox_claim.call_args.kwargs,
            "pod_patch": warm_pool_client.patch_pod_metadata.call_args.kwargs,
        },
        default=str,
    )
    assert "iOuoSwc/HrF6ZhttvtSNeQ==" not in metadata_calls


def test_create_executor_from_warmpool_reconciles_reusable_claim_metadata(mocker):
    executor = object.__new__(K8sExecutor)
    mocker.patch(
        "executor_manager.wecode.executors.k8s.k8s_executor._get_api_client",
        return_value=object(),
    )
    warm_pool_client = mocker.MagicMock()
    warm_pool_client.get_sandbox_claim.return_value = {
        "spec": {
            "sandboxTemplateRef": {
                "name": "wegent-executor-standard-1.0.214",
            }
        }
    }
    warm_pool_client.get_sandbox_status.return_value = {
        "exists": True,
        "phase": "Running",
        "pod_name": "pod-1",
        "pod_ip": "10.0.0.8",
    }
    mocker.patch(
        "executor_manager.wecode.executors.warmpool.WarmPoolClient",
        return_value=warm_pool_client,
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
        task={"task_id": 123, "type": "online"},
        executor_name="executor-1",
        user_name="test_user",
        task_id="123",
        subtask_id="456",
        template_name="wegent-executor-standard-1.0.214",
        workload_type="executor",
    )

    assert result == {"status": "success"}
    warm_pool_client.create_sandbox_claim.assert_not_called()
    warm_pool_client.patch_pod_metadata.assert_called_once()
    repository.save_executor_binding.assert_called_once()


def test_non_git_online_task_is_executor_warmpool_eligible(mocker):
    executor = object.__new__(K8sExecutor)
    module = "executor_manager.wecode.executors.k8s.k8s_executor"
    mocker.patch(
        f"{module}.EXECUTOR_DEFAULT_MAGE",
        "registry/executor:1.0.214",
    )
    mocker.patch(f"{module}.EXECUTOR_NON_GIT_WARMPOOL_ENABLED", True)

    reason = executor._executor_warmpool_ineligibility_reason(
        {
            "task_id": 123,
            "type": "online",
            "user": {
                "name": "test_user",
                # A configured Git account does not make this a Git task.
                "git_domain": "git.intra.weibo.com",
            },
        },
        "registry/executor:1.0.214",
    )

    assert reason is None


def test_non_git_online_task_skips_warmpool_by_default(mocker):
    executor = object.__new__(K8sExecutor)
    module = "executor_manager.wecode.executors.k8s.k8s_executor"
    mocker.patch(f"{module}.EXECUTOR_DEFAULT_MAGE", "registry/executor:1.0.214")
    mocker.patch(f"{module}.EXECUTOR_NON_GIT_WARMPOOL_ENABLED", False)

    reason = executor._executor_warmpool_ineligibility_reason(
        {"task_id": 123, "type": "online", "user": {"name": "test_user"}},
        "registry/executor:1.0.214",
    )

    assert reason == "non_git_warmpool_disabled"


def test_executor_warmpool_is_enabled_by_default(monkeypatch):
    from executor_manager.wecode.config import config

    with monkeypatch.context() as patch:
        patch.delenv("EXECUTOR_WARMPOOL_ENABLED", raising=False)
        patch.delenv("EXECUTOR_NON_GIT_WARMPOOL_ENABLED", raising=False)
        patch.delenv("EXECUTOR_GIT_WARMPOOL_ENABLED", raising=False)
        reloaded_config = importlib.reload(config)
        assert reloaded_config.EXECUTOR_WARMPOOL_ENABLED is True
        assert reloaded_config.EXECUTOR_NON_GIT_WARMPOOL_ENABLED is False
        assert reloaded_config.EXECUTOR_GIT_WARMPOOL_ENABLED is False

    importlib.reload(config)


def test_create_instance_claims_shared_sandbox_warmpool(mocker):
    executor = object.__new__(K8sExecutor)
    module = "executor_manager.wecode.executors.k8s.k8s_executor"
    mocker.patch(f"{module}.WARMPOOL_ENABLED", True)
    mocker.patch(f"{module}.EXECUTOR_WARMPOOL_ENABLED", True)
    mocker.patch(f"{module}.EXECUTOR_NON_GIT_WARMPOOL_ENABLED", True)
    mocker.patch(
        f"{module}.WARMPOOL_TEMPLATE_NAME",
        "wegent-sandbox-1.0.214",
    )
    mocker.patch(f"{module}.EXECUTOR_DEFAULT_MAGE", "registry/executor:1.0.214")
    claim = mocker.patch.object(
        executor,
        "_create_pod_from_warmpool",
        return_value={"status": "success"},
    )
    direct_create = mocker.patch(f"{module}.build_pod_configuration")

    executor.create_instance(
        task={
            "task_id": 123,
            "type": "online",
            "user": {"name": "test_user"},
        },
        task_info={
            "task_id": "123",
            "subtask_id": "456",
            "user_name": "test_user",
        },
        executor_name="executor-1",
    )

    claim.assert_called_once_with(
        task={
            "task_id": 123,
            "type": "online",
            "user": {"name": "test_user"},
        },
        executor_name="executor-1",
        user_name="test_user",
        task_id="123",
        subtask_id="456",
        template_name="wegent-sandbox-1.0.214",
        workload_type="executor",
    )
    direct_create.assert_not_called()


def test_create_instance_uses_direct_pod_for_git_task(mocker):
    executor = object.__new__(K8sExecutor)
    module = "executor_manager.wecode.executors.k8s.k8s_executor"
    mocker.patch(f"{module}.WARMPOOL_ENABLED", True)
    mocker.patch(f"{module}.EXECUTOR_WARMPOOL_ENABLED", True)
    mocker.patch(f"{module}.EXECUTOR_GIT_WARMPOOL_ENABLED", False)
    mocker.patch(f"{module}.WARMPOOL_TEMPLATE_NAME", "wegent-sandbox-1.0.214")
    mocker.patch(f"{module}.EXECUTOR_DEFAULT_MAGE", "registry/executor:1.0.214")
    claim = mocker.patch.object(executor, "_create_pod_from_warmpool")
    direct_pod = {"metadata": {"name": "executor-1"}}
    build = mocker.patch(f"{module}.build_pod_configuration", return_value=direct_pod)
    submit = mocker.patch.object(
        executor,
        "_submit_kubernetes_pod",
        return_value={"status": "success"},
    )

    task = {
        "task_id": 123,
        "type": "online",
        "git_url": "https://github.com/wecode-ai/Wegent.git",
        "git_repo": "wecode-ai/Wegent",
        "git_auth_transport": "encrypted_request_token",
        "user": {
            "name": "test_user",
            "git_domain": "github.com",
            "git_token": "iOuoSwc/HrF6ZhttvtSNeQ==",
        },
    }
    executor.create_instance(
        task=task,
        task_info={
            "task_id": "123",
            "subtask_id": "456",
            "user_name": "test_user",
        },
        executor_name="executor-1",
    )

    claim.assert_not_called()
    build.assert_called_once()
    submit.assert_called_once_with(direct_pod, K8S_NAMESPACE, "executor-1", "123")


def test_create_instance_claims_warmpool_for_safe_https_git_task(mocker):
    executor = object.__new__(K8sExecutor)
    module = "executor_manager.wecode.executors.k8s.k8s_executor"
    mocker.patch(f"{module}.WARMPOOL_ENABLED", True)
    mocker.patch(f"{module}.EXECUTOR_WARMPOOL_ENABLED", True)
    mocker.patch(f"{module}.EXECUTOR_GIT_WARMPOOL_ENABLED", True)
    mocker.patch(f"{module}.WARMPOOL_TEMPLATE_NAME", "wegent-sandbox-1.0.214")
    mocker.patch(f"{module}.EXECUTOR_DEFAULT_MAGE", "registry/executor:1.0.214")
    claim = mocker.patch.object(
        executor,
        "_create_pod_from_warmpool",
        return_value={"status": "success"},
    )
    direct_create = mocker.patch(f"{module}.build_pod_configuration")
    task = {
        "task_id": 123,
        "type": "online",
        "git_url": "https://github.com/wecode-ai/Wegent.git",
        "git_auth_transport": "encrypted_request_token",
        "user": {
            "name": "test_user",
            "git_domain": "github.com",
            "git_token": "iOuoSwc/HrF6ZhttvtSNeQ==",
        },
    }

    executor.create_instance(
        task=task,
        task_info={
            "task_id": "123",
            "subtask_id": "456",
            "user_name": "test_user",
        },
        executor_name="executor-1",
    )

    claim.assert_called_once_with(
        task=task,
        executor_name="executor-1",
        user_name="test_user",
        task_id="123",
        subtask_id="456",
        template_name="wegent-sandbox-1.0.214",
        workload_type="executor",
    )
    direct_create.assert_not_called()


def test_git_warmpool_runtime_capabilities_require_proxy_secret_and_image():
    image = "registry/executor:1.0.214"
    git_url = "https://github.com/wecode-ai/Wegent.git"
    pod = build_warm_pool_pod_config(executor_image=image)
    template = {
        "spec": {
            "podTemplate": {
                "spec": pod["spec"],
            }
        }
    }

    assert (
        git_warmpool_runtime_ineligibility_reason(
            git_url, template, image, is_template=True
        )
        is None
    )
    assert (
        git_warmpool_runtime_ineligibility_reason(
            git_url, pod, image, is_template=False
        )
        is None
    )

    missing_proxy = json.loads(json.dumps(pod))
    missing_proxy["spec"]["containers"][0]["env"] = [
        item
        for item in missing_proxy["spec"]["containers"][0]["env"]
        if item.get("name") != "REPO_PROXY_CONFIG"
    ]
    assert (
        git_warmpool_runtime_ineligibility_reason(
            git_url, missing_proxy, image, is_template=False
        )
        == "git_warmpool_missing_repo_proxy"
    )

    missing_secret = json.loads(json.dumps(pod))
    missing_secret["spec"]["volumes"] = [
        volume
        for volume in missing_secret["spec"]["volumes"]
        if volume.get("name") != "wegent-executor-secret"
    ]
    assert (
        git_warmpool_runtime_ineligibility_reason(
            git_url, missing_secret, image, is_template=False
        )
        == "git_warmpool_missing_crypto_secret"
    )
    assert (
        git_warmpool_runtime_ineligibility_reason(
            git_url, pod, "registry/executor:1.0.215", is_template=False
        )
        == "git_warmpool_image_mismatch"
    )


def test_create_git_executor_discards_incompatible_claimed_warmpool_pod(mocker):
    executor = object.__new__(K8sExecutor)
    image = "registry/executor:1.0.214"
    task = {
        "task_id": 123,
        "type": "online",
        "executor_image": image,
        "git_url": "https://github.com/wecode-ai/Wegent.git",
    }
    compatible_pod = build_warm_pool_pod_config(executor_image=image)
    template = {
        "spec": {
            "podTemplate": {
                "spec": compatible_pod["spec"],
            }
        }
    }
    incompatible_pod = json.loads(json.dumps(compatible_pod))
    incompatible_pod["spec"]["containers"][0]["env"] = [
        item
        for item in incompatible_pod["spec"]["containers"][0]["env"]
        if item.get("name") != "REPO_PROXY_CONFIG"
    ]
    mocker.patch(
        "executor_manager.wecode.executors.k8s.k8s_executor._get_api_client",
        return_value=object(),
    )
    warm_pool_client = mocker.MagicMock()
    warm_pool_client.get_sandbox_template.return_value = template
    warm_pool_client.get_sandbox_claim.side_effect = [
        None,
        {"metadata": {"name": "executor-1"}},
    ]
    warm_pool_client.core_api.read_namespaced_pod.return_value = incompatible_pod
    mocker.patch(
        "executor_manager.wecode.executors.warmpool.WarmPoolClient",
        return_value=warm_pool_client,
    )
    mocker.patch.object(
        executor,
        "_wait_for_warmpool_sandbox_ready",
        return_value={"pod_name": "warm-pod-1", "pod_ip": "10.0.0.8"},
    )

    result = executor._create_pod_from_warmpool(
        task=task,
        executor_name="executor-1",
        user_name="test_user",
        task_id="123",
        subtask_id="456",
        template_name="wegent-executor-standard-1.0.214",
        workload_type="executor",
    )

    assert result == {
        "status": "fallback",
        "fallback_reason": "git_warmpool_missing_repo_proxy",
    }
    warm_pool_client.create_sandbox_claim.assert_called_once()
    warm_pool_client.delete_sandbox_claim.assert_called_once_with("executor-1")
    warm_pool_client.patch_pod_metadata.assert_not_called()


def test_create_instance_falls_back_to_direct_pod_for_incompatible_git_warmpool(
    mocker,
):
    executor = object.__new__(K8sExecutor)
    module = "executor_manager.wecode.executors.k8s.k8s_executor"
    image = "registry/executor:1.0.214"
    mocker.patch(f"{module}.WARMPOOL_ENABLED", True)
    mocker.patch(f"{module}.EXECUTOR_WARMPOOL_ENABLED", True)
    mocker.patch(f"{module}.EXECUTOR_GIT_WARMPOOL_ENABLED", True)
    mocker.patch(f"{module}.WARMPOOL_TEMPLATE_NAME", "wegent-sandbox-1.0.214")
    mocker.patch(f"{module}.EXECUTOR_DEFAULT_MAGE", image)
    mocker.patch.object(
        executor,
        "_create_pod_from_warmpool",
        return_value={
            "status": "fallback",
            "fallback_reason": "git_warmpool_missing_repo_proxy",
        },
    )
    direct_pod = {"metadata": {"name": "executor-1"}}
    build = mocker.patch(f"{module}.build_pod_configuration", return_value=direct_pod)
    submit = mocker.patch.object(
        executor,
        "_submit_kubernetes_pod",
        return_value={"status": "success"},
    )
    task = {
        "task_id": 123,
        "type": "online",
        "git_url": "https://github.com/wecode-ai/Wegent.git",
        "git_auth_transport": "encrypted_request_token",
        "user": {
            "name": "test_user",
            "git_domain": "github.com",
            "git_token": "iOuoSwc/HrF6ZhttvtSNeQ==",
        },
    }

    executor.create_instance(
        task=task,
        task_info={
            "task_id": "123",
            "subtask_id": "456",
            "user_name": "test_user",
        },
        executor_name="executor-1",
    )

    build.assert_called_once()
    submit.assert_called_once_with(direct_pod, K8S_NAMESPACE, "executor-1", "123")


def test_executor_warmpool_rejects_task_specific_pod_shapes(mocker):
    executor = object.__new__(K8sExecutor)
    mocker.patch(
        "executor_manager.wecode.executors.k8s.k8s_executor.EXECUTOR_DEFAULT_MAGE",
        "registry/executor:1.0.214",
    )

    assert (
        executor._executor_warmpool_ineligibility_reason(
            {
                "type": "online",
                "bot": [{"base_image": "registry/custom:latest"}],
            },
            "registry/executor:1.0.214",
        )
        == "custom_base_image"
    )
    assert (
        executor._executor_warmpool_ineligibility_reason(
            {"type": "online"},
            "registry/executor:custom",
        )
        == "executor_image_mismatch"
    )


def test_executor_warmpool_accepts_https_git_with_encrypted_request_token(mocker):
    executor = object.__new__(K8sExecutor)
    module = "executor_manager.wecode.executors.k8s.k8s_executor"
    mocker.patch(f"{module}.EXECUTOR_DEFAULT_MAGE", "registry/executor:1.0.214")
    mocker.patch(f"{module}.EXECUTOR_GIT_WARMPOOL_ENABLED", True)

    reason = executor._executor_warmpool_ineligibility_reason(
        {
            "type": "online",
            "git_url": "https://github.com/org/repo.git",
            "git_auth_transport": "encrypted_request_token",
            "user": {
                "git_domain": "https://github.com",
                "git_token": "iOuoSwc/HrF6ZhttvtSNeQ==",
            },
        },
        "registry/executor:1.0.214",
    )

    assert reason is None


def test_executor_warmpool_rejects_unsafe_git_credentials(mocker):
    executor = object.__new__(K8sExecutor)
    module = "executor_manager.wecode.executors.k8s.k8s_executor"
    mocker.patch(f"{module}.EXECUTOR_DEFAULT_MAGE", "registry/executor:1.0.214")
    mocker.patch(f"{module}.EXECUTOR_GIT_WARMPOOL_ENABLED", True)
    encrypted_token = "iOuoSwc/HrF6ZhttvtSNeQ=="
    base_task = {
        "type": "online",
        "git_url": "https://github.com/org/repo.git",
        "git_auth_transport": "encrypted_request_token",
        "user": {"git_domain": "github.com", "git_token": encrypted_token},
    }
    cases = [
        (
            {**base_task, "git_url": "ssh://git@github.com/org/repo.git"},
            "git_requires_https",
        ),
        (
            {**base_task, "git_url": "http://github.com/org/repo.git"},
            "git_requires_https",
        ),
        (
            {
                **base_task,
                "git_url": "https://octocat:token@github.com/org/repo.git",
            },
            "git_url_contains_credentials",
        ),
        (
            {**base_task, "git_url": "https://github.com/org/repo.git?token=x"},
            "git_url_contains_credentials",
        ),
        ({**base_task, "workspace_source": "git_worktree"}, "git_worktree"),
        (
            {**base_task, "git_auth_transport": "legacy_user_secret"},
            "git_credentials_not_request_scoped",
        ),
        (
            {**base_task, "user": {"git_domain": "github.com", "git_token": "***"}},
            "git_credentials_missing",
        ),
        (
            {**base_task, "user": {"git_domain": "github.com", "git_token": "plain"}},
            "git_credentials_not_encrypted",
        ),
        (
            {
                **base_task,
                "user": {"git_domain": "gitlab.com", "git_token": encrypted_token},
            },
            "git_credential_domain_mismatch",
        ),
    ]

    for task, expected_reason in cases:
        assert (
            executor._executor_warmpool_ineligibility_reason(
                task,
                "registry/executor:1.0.214",
            )
            == expected_reason
        )


def test_delete_executor_by_task_id_falls_back_from_stale_binding(mocker):
    executor = object.__new__(K8sExecutor)
    repository = mocker.MagicMock()
    repository.load_executor_binding_full.return_value = {
        "executor_name": "executor-claim-1",
        "sandbox_claim_name": "executor-claim-1",
    }
    mocker.patch(
        "executor_manager.services.sandbox.repository.get_sandbox_repository",
        return_value=repository,
    )
    mocker.patch.object(
        executor,
        "delete_sandbox_claim",
        return_value={"status": "not_found"},
    )
    core_v1 = mocker.MagicMock()
    core_v1.list_namespaced_pod.return_value = SimpleNamespace(
        items=[SimpleNamespace(metadata=SimpleNamespace(name="warmpool-pod-abc"))]
    )
    mocker.patch.object(executor, "_get_core_v1_api", return_value=core_v1)
    delete_executor = mocker.patch.object(
        executor,
        "delete_executor",
        return_value={"status": "success"},
    )

    result = executor.delete_executor_by_task_id("123")

    assert result == {
        "status": "success",
        "deleted_pods": ["warmpool-pod-abc"],
    }
    delete_executor.assert_called_once_with("warmpool-pod-abc", K8S_NAMESPACE)
    repository.delete_executor_binding.assert_called_once_with(123)


def test_get_old_task_ids_includes_bound_warmpool_and_claim_only(mocker):
    executor = object.__new__(K8sExecutor)
    mocker.patch(
        "executor_manager.wecode.executors.k8s.k8s_executor.WARMPOOL_ENABLED",
        True,
    )
    old_timestamp = (datetime.now(timezone.utc) - timedelta(hours=72)).isoformat()
    pods = [
        {
            "metadata": {
                "name": "wegent-task-direct-abc",
                "creationTimestamp": old_timestamp,
                "labels": {
                    LABEL_EXECUTOR: LABEL_EXECUTOR_VALUE,
                    LABEL_TASK_ID: "101",
                },
            },
            "status": {"phase": "Running"},
        },
        {
            "metadata": {
                "name": "wegent-executor-standard-warmpool-1.0.221-abc",
                "creationTimestamp": old_timestamp,
                "labels": {
                    LABEL_EXECUTOR: LABEL_EXECUTOR_VALUE,
                    LABEL_TASK_ID: "102",
                    LABEL_POOL_STATE: "bound",
                    LABEL_POOL_PROFILE: POOL_PROFILE_EXECUTOR_STANDARD,
                    LABEL_WARM_POOL: "true",
                },
                "ownerReferences": [
                    {
                        "apiVersion": "agents.x-k8s.io/v1alpha1",
                        "kind": "Sandbox",
                        "name": "executor-claim-102",
                    }
                ],
            },
            "status": {"phase": "Running"},
        },
        {
            "metadata": {
                "name": "wegent-sandbox-warmpools-1.0.177-standby",
                "creationTimestamp": old_timestamp,
                "labels": {
                    LABEL_EXECUTOR: LABEL_EXECUTOR_VALUE,
                    LABEL_WARM_POOL: "true",
                },
            },
            "status": {"phase": "Running"},
        },
        {
            "metadata": {
                "name": "wegent-sandbox-claimed-interactive",
                "creationTimestamp": old_timestamp,
                "labels": {
                    LABEL_EXECUTOR: LABEL_EXECUTOR_VALUE,
                    LABEL_TASK_ID: "104",
                    LABEL_POOL_STATE: "bound",
                    LABEL_WARM_POOL: "true",
                },
            },
            "status": {"phase": "Running"},
        },
    ]
    core_v1 = mocker.MagicMock()
    core_v1.api_client = object()
    core_v1.list_namespaced_pod.return_value = SimpleNamespace(
        data=json.dumps({"items": pods}).encode("utf-8")
    )
    mocker.patch.object(executor, "_get_core_v1_api", return_value=core_v1)
    warm_pool_client = mocker.MagicMock()
    warm_pool_client.list_sandbox_claims.return_value = [
        {
            "metadata": {
                "name": "executor-claim-102",
                "creationTimestamp": old_timestamp,
                "labels": {LABEL_TASK_ID: "102"},
            }
        },
        {
            "metadata": {
                "name": "executor-claim-103",
                "creationTimestamp": old_timestamp,
                "labels": {LABEL_TASK_ID: "103"},
            }
        },
    ]
    mocker.patch(
        "executor_manager.wecode.executors.warmpool.WarmPoolClient",
        return_value=warm_pool_client,
    )

    result = executor.get_old_task_ids(older_than_hours=48)

    assert result == {
        "status": "success",
        "pods": [
            {
                "task_id": "101",
                "pod_name": "wegent-task-direct-abc",
                "status": "Running",
            },
            {
                "task_id": "102",
                "pod_name": "executor-claim-102",
                "status": "Running",
            },
            {
                "task_id": "103",
                "pod_name": "executor-claim-103",
                "status": "",
            },
        ],
    }
    warm_pool_client.list_sandbox_claims.assert_called_once_with(
        f"{LABEL_EXECUTOR}={LABEL_EXECUTOR_VALUE},"
        f"{LABEL_POOL_PROFILE}={POOL_PROFILE_EXECUTOR_STANDARD}"
    )


def _conflict_error():
    return ApiException(status=409, reason="Conflict")


def test_submit_kubernetes_pod_adopts_running_pod_on_conflict(mocker):
    executor = object.__new__(K8sExecutor)
    core_v1 = mocker.MagicMock()
    core_v1.create_namespaced_pod.side_effect = _conflict_error()
    core_v1.read_namespaced_pod.return_value = SimpleNamespace(
        metadata=SimpleNamespace(
            deletion_timestamp=None,
            creation_timestamp=datetime.now(timezone.utc),
        ),
        status=SimpleNamespace(phase="Running"),
    )
    mocker.patch.object(executor, "_get_core_v1_api", return_value=core_v1)
    delete = mocker.patch.object(executor, "delete_executor")

    result = executor._submit_kubernetes_pod(
        pod=object(), namespace=K8S_NAMESPACE, pod_name="executor-1", task_id="123"
    )

    assert result == {"status": "success", "pod_name": "executor-1"}
    core_v1.read_namespaced_pod.assert_called_once()
    delete.assert_not_called()
    core_v1.create_namespaced_pod.assert_called_once()


def test_submit_kubernetes_pod_recreates_old_pod_on_conflict(mocker):
    executor = object.__new__(K8sExecutor)
    core_v1 = mocker.MagicMock()
    core_v1.create_namespaced_pod.side_effect = [
        _conflict_error(),
        SimpleNamespace(metadata=SimpleNamespace(name="executor-1")),
    ]
    core_v1.read_namespaced_pod.return_value = SimpleNamespace(
        metadata=SimpleNamespace(
            deletion_timestamp=None,
            creation_timestamp=datetime.now(timezone.utc) - timedelta(hours=1),
        ),
        status=SimpleNamespace(phase="Running"),
    )
    mocker.patch.object(executor, "_get_core_v1_api", return_value=core_v1)
    delete = mocker.patch.object(executor, "delete_executor")
    mocker.patch.object(executor, "_wait_pod_deleted", return_value=True)

    result = executor._submit_kubernetes_pod(
        pod=object(), namespace=K8S_NAMESPACE, pod_name="executor-1", task_id="123"
    )

    assert result == {"status": "success", "pod_name": "executor-1"}
    delete.assert_called_once_with("executor-1", K8S_NAMESPACE)
    assert core_v1.create_namespaced_pod.call_count == 2


def test_submit_kubernetes_pod_recreates_stale_pod_on_conflict(mocker):
    executor = object.__new__(K8sExecutor)
    core_v1 = mocker.MagicMock()
    core_v1.create_namespaced_pod.side_effect = [
        _conflict_error(),
        SimpleNamespace(metadata=SimpleNamespace(name="executor-1")),
    ]
    core_v1.read_namespaced_pod.return_value = SimpleNamespace(
        metadata=SimpleNamespace(
            deletion_timestamp=None,
            creation_timestamp=datetime.now(timezone.utc),
        ),
        status=SimpleNamespace(phase="Succeeded"),
    )
    mocker.patch.object(executor, "_get_core_v1_api", return_value=core_v1)
    delete = mocker.patch.object(executor, "delete_executor")
    mocker.patch.object(executor, "_wait_pod_deleted", return_value=True)

    result = executor._submit_kubernetes_pod(
        pod=object(), namespace=K8S_NAMESPACE, pod_name="executor-1", task_id="123"
    )

    assert result == {"status": "success", "pod_name": "executor-1"}
    delete.assert_called_once_with("executor-1", K8S_NAMESPACE)
    assert core_v1.create_namespaced_pod.call_count == 2


def test_submit_kubernetes_pod_fails_when_stale_pod_stuck(mocker):
    executor = object.__new__(K8sExecutor)
    core_v1 = mocker.MagicMock()
    core_v1.create_namespaced_pod.side_effect = _conflict_error()
    core_v1.read_namespaced_pod.return_value = SimpleNamespace(
        metadata=SimpleNamespace(
            deletion_timestamp="2026-07-13T00:00:00Z",
            creation_timestamp=datetime.now(timezone.utc),
        ),
        status=SimpleNamespace(phase="Running"),
    )
    mocker.patch.object(executor, "_get_core_v1_api", return_value=core_v1)
    mocker.patch.object(executor, "delete_executor")
    mocker.patch.object(executor, "_wait_pod_deleted", return_value=False)

    result = executor._submit_kubernetes_pod(
        pod=object(), namespace=K8S_NAMESPACE, pod_name="executor-1", task_id="123"
    )

    assert result["status"] == "failed"
    assert core_v1.create_namespaced_pod.call_count == 1


def test_submit_executor_cleans_up_pod_on_prepare_failure(mocker):
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
    mocker.patch.object(executor, "create_instance", side_effect=RuntimeError("boom"))
    cleanup = mocker.patch.object(executor, "delete_executor")
    mocker.patch.object(executor, "_send_failure_callback")

    result = executor.submit_executor(prepare_task)

    assert result["status"] == "failed"
    cleanup.assert_called_once_with(result["executor_name"], K8S_NAMESPACE)


def _warmpool_cr(name: str, template: str, age_days: float) -> dict:
    created = datetime.now(timezone.utc) - timedelta(days=age_days)
    return {
        "metadata": {
            "name": name,
            "creationTimestamp": created.isoformat().replace("+00:00", "Z"),
        },
        "spec": {"sandboxTemplateRef": {"name": template}},
    }


def _mock_warmpool_client(mocker, warmpools):
    mocker.patch(
        "executor_manager.wecode.executors.k8s.k8s_executor._get_api_client",
        return_value=object(),
    )
    warm_pool_client = mocker.MagicMock()
    warm_pool_client.list_sandbox_warmpools.return_value = warmpools
    mocker.patch(
        "executor_manager.wecode.executors.warmpool.WarmPoolClient",
        return_value=warm_pool_client,
    )
    return warm_pool_client


def test_cleanup_stale_warmpools_deletes_old_mismatched_template(mocker):
    mocker.patch(
        "executor_manager.wecode.executors.k8s.k8s_executor.WARMPOOL_TEMPLATE_NAME",
        "wegent-sandbox-1.0.247",
    )
    executor = object.__new__(K8sExecutor)
    warm_pool_client = _mock_warmpool_client(
        mocker,
        [
            _warmpool_cr("pool-old", "wegent-sandbox-1.0.234", age_days=12),
            _warmpool_cr("pool-current", "wegent-sandbox-1.0.247", age_days=30),
        ],
    )

    result = executor.cleanup_stale_warmpools(grace_period_days=7)

    warm_pool_client.delete_sandbox_warmpool.assert_called_once_with("pool-old")
    assert result["deleted"] == [
        {"name": "pool-old", "template": "wegent-sandbox-1.0.234"}
    ]
    assert {item["reason"] for item in result["skipped"]} == {"current_template"}


def test_cleanup_stale_warmpools_records_failed_count(mocker):
    mocker.patch(
        "executor_manager.wecode.executors.k8s.k8s_executor.WARMPOOL_TEMPLATE_NAME",
        "wegent-sandbox-1.0.247",
    )
    executor = object.__new__(K8sExecutor)
    warm_pool_client = _mock_warmpool_client(
        mocker,
        [
            _warmpool_cr("pool-forbidden", "wegent-sandbox-1.0.234", age_days=12),
            _warmpool_cr("pool-old", "wegent-sandbox-1.0.233", age_days=20),
        ],
    )
    warm_pool_client.delete_sandbox_warmpool.side_effect = [
        ApiException(status=403, reason="Forbidden"),
        None,
    ]

    result = executor.cleanup_stale_warmpools(grace_period_days=7)

    assert result["failed_count"] == 1
    assert [item["name"] for item in result["failed"]] == ["pool-forbidden"]
    assert result["deleted"] == [
        {"name": "pool-old", "template": "wegent-sandbox-1.0.233"}
    ]


def test_cleanup_stale_warmpools_keeps_cr_within_grace_period(mocker):
    mocker.patch(
        "executor_manager.wecode.executors.k8s.k8s_executor.WARMPOOL_TEMPLATE_NAME",
        "wegent-sandbox-1.0.247",
    )
    executor = object.__new__(K8sExecutor)
    warm_pool_client = _mock_warmpool_client(
        mocker,
        [_warmpool_cr("pool-recent", "wegent-sandbox-1.0.246", age_days=3)],
    )

    result = executor.cleanup_stale_warmpools(grace_period_days=7)

    warm_pool_client.delete_sandbox_warmpool.assert_not_called()
    assert result["deleted"] == []
    assert result["skipped"][0]["reason"] == "within_grace_period"


def test_cleanup_stale_warmpools_dry_run_does_not_delete(mocker):
    mocker.patch(
        "executor_manager.wecode.executors.k8s.k8s_executor.WARMPOOL_TEMPLATE_NAME",
        "wegent-sandbox-1.0.247",
    )
    executor = object.__new__(K8sExecutor)
    warm_pool_client = _mock_warmpool_client(
        mocker,
        [_warmpool_cr("pool-old", "wegent-sandbox-1.0.234", age_days=12)],
    )

    result = executor.cleanup_stale_warmpools(grace_period_days=7, dry_run=True)

    warm_pool_client.delete_sandbox_warmpool.assert_not_called()
    assert result["deleted"] == []
    assert result["skipped"][0]["reason"] == "dry_run"


def test_cleanup_stale_warmpools_skips_when_template_not_configured(mocker):
    mocker.patch(
        "executor_manager.wecode.executors.k8s.k8s_executor.WARMPOOL_TEMPLATE_NAME",
        "",
    )
    executor = object.__new__(K8sExecutor)

    result = executor.cleanup_stale_warmpools()

    assert result["status"] == "skipped"
    assert result["reason"] == "warmpool_template_not_configured"
