# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Tests for warmpool_client module.
"""

import json
from unittest.mock import MagicMock, patch

import pytest
from kubernetes.client.rest import ApiException

from executor_manager.wecode.executors.warmpool.warmpool_client import WarmPoolClient
from executor_manager.wecode.executors.warmpool.constants import (
    ANNOTATION_TASK_INFO,
    SANDBOX_API_GROUP,
    SANDBOX_API_VERSION,
    SANDBOX_CLAIM_API_GROUP,
    SANDBOX_CLAIM_API_VERSION,
    SANDBOX_CLAIM_PLURAL,
    SANDBOX_PLURAL,
)


class TestSandboxClaimOperations:
    """Tests for SandboxClaim operations."""

    @pytest.fixture
    def mock_api_client(self):
        """Create a mock API client."""
        return MagicMock()

    @pytest.fixture
    def client(self, mock_api_client):
        """Create a WarmPoolClient instance with mocked API client."""
        return WarmPoolClient(mock_api_client, "test-namespace")

    def test_create_sandbox_claim(self, client):
        """Should create a SandboxClaim CR with correct parameters."""
        client.custom_api.create_namespaced_custom_object = MagicMock(
            return_value={"metadata": {"name": "test-claim"}}
        )

        task_info = {"task_id": 123, "subtask_id": 456}
        labels = {"app": "test-claim"}
        annotations = {"custom": "annotation"}

        result = client.create_sandbox_claim(
            name="test-claim",
            template_name="test-template",
            labels=labels,
            annotations=annotations,
            task_info=task_info,
        )

        # Verify the call was made
        client.custom_api.create_namespaced_custom_object.assert_called_once()

        # Get the call arguments
        call_kwargs = client.custom_api.create_namespaced_custom_object.call_args[1]
        assert call_kwargs["group"] == SANDBOX_CLAIM_API_GROUP
        assert call_kwargs["version"] == SANDBOX_CLAIM_API_VERSION
        assert call_kwargs["namespace"] == "test-namespace"
        assert call_kwargs["plural"] == SANDBOX_CLAIM_PLURAL

        # Verify body structure
        body = call_kwargs["body"]
        assert body["kind"] == "SandboxClaim"
        assert body["metadata"]["name"] == "test-claim"
        assert body["spec"]["sandboxTemplateRef"]["name"] == "test-template"
        assert ANNOTATION_TASK_INFO in body["metadata"]["annotations"]
        assert (
            json.loads(body["metadata"]["annotations"][ANNOTATION_TASK_INFO])
            == task_info
        )

    def test_get_sandbox_claim_returns_claim(self, client):
        """Should return sandbox claim when found."""
        expected = {"metadata": {"name": "test-claim"}, "status": {"phase": "Bound"}}
        client.custom_api.get_namespaced_custom_object = MagicMock(return_value=expected)

        result = client.get_sandbox_claim("test-claim")

        assert result == expected
        client.custom_api.get_namespaced_custom_object.assert_called_once()

    def test_get_sandbox_claim_returns_none_when_not_found(self, client):
        """Should return None when sandbox claim not found."""
        client.custom_api.get_namespaced_custom_object = MagicMock(
            side_effect=ApiException(status=404)
        )

        result = client.get_sandbox_claim("nonexistent")

        assert result is None

    def test_delete_sandbox_claim(self, client):
        """Should delete sandbox claim."""
        client.custom_api.delete_namespaced_custom_object = MagicMock(
            return_value={"status": "Success"}
        )

        result = client.delete_sandbox_claim("test-claim")

        client.custom_api.delete_namespaced_custom_object.assert_called_once()
        call_kwargs = client.custom_api.delete_namespaced_custom_object.call_args[1]
        assert call_kwargs["group"] == SANDBOX_CLAIM_API_GROUP
        assert call_kwargs["plural"] == SANDBOX_CLAIM_PLURAL

    def test_list_sandbox_claims(self, client):
        """Should list sandbox claims with label selector."""
        expected_items = [
            {"metadata": {"name": "claim-1"}},
            {"metadata": {"name": "claim-2"}},
        ]
        client.custom_api.list_namespaced_custom_object = MagicMock(
            return_value={"items": expected_items}
        )

        result = client.list_sandbox_claims("app=test")

        assert result == expected_items
        client.custom_api.list_namespaced_custom_object.assert_called_once()
        call_kwargs = client.custom_api.list_namespaced_custom_object.call_args[1]
        assert call_kwargs["group"] == SANDBOX_CLAIM_API_GROUP
        assert call_kwargs["plural"] == SANDBOX_CLAIM_PLURAL

    def test_patch_sandbox_claim(self, client):
        """Should patch sandbox claim annotations."""
        client.custom_api.patch_namespaced_custom_object = MagicMock(
            return_value={"metadata": {"name": "test-claim"}}
        )

        task_info = {"task_id": 789}
        result = client.patch_sandbox_claim(
            name="test-claim",
            task_info=task_info,
        )

        client.custom_api.patch_namespaced_custom_object.assert_called_once()
        call_kwargs = client.custom_api.patch_namespaced_custom_object.call_args[1]
        assert call_kwargs["group"] == SANDBOX_CLAIM_API_GROUP
        assert call_kwargs["plural"] == SANDBOX_CLAIM_PLURAL
        body = call_kwargs["body"]
        assert ANNOTATION_TASK_INFO in body["metadata"]["annotations"]


class TestSandboxStatusOperations:
    """Tests for Sandbox status operations (read-only)."""

    @pytest.fixture
    def client(self):
        """Create a WarmPoolClient instance."""
        mock_api_client = MagicMock()
        return WarmPoolClient(mock_api_client, "test-namespace")

    def test_get_sandbox_returns_sandbox(self, client):
        """Should return sandbox when found."""
        expected = {"metadata": {"name": "test-sandbox"}, "status": {"phase": "Running"}}
        client.custom_api.get_namespaced_custom_object = MagicMock(return_value=expected)

        result = client.get_sandbox("test-sandbox")

        assert result == expected
        call_kwargs = client.custom_api.get_namespaced_custom_object.call_args[1]
        assert call_kwargs["group"] == SANDBOX_API_GROUP
        assert call_kwargs["plural"] == SANDBOX_PLURAL

    def test_get_sandbox_returns_none_when_not_found(self, client):
        """Should return None when sandbox not found."""
        client.custom_api.get_namespaced_custom_object = MagicMock(
            side_effect=ApiException(status=404)
        )

        result = client.get_sandbox("nonexistent")

        assert result is None

    def test_get_sandbox_raises_on_other_errors(self, client):
        """Should raise ApiException for non-404 errors."""
        client.custom_api.get_namespaced_custom_object = MagicMock(
            side_effect=ApiException(status=500)
        )

        with pytest.raises(ApiException):
            client.get_sandbox("test-sandbox")

    def test_list_sandboxes(self, client):
        """Should list sandboxes with label selector."""
        expected_items = [
            {"metadata": {"name": "sandbox-1"}},
            {"metadata": {"name": "sandbox-2"}},
        ]
        client.custom_api.list_namespaced_custom_object = MagicMock(
            return_value={"items": expected_items}
        )

        result = client.list_sandboxes("app=test")

        assert result == expected_items
        call_kwargs = client.custom_api.list_namespaced_custom_object.call_args[1]
        assert call_kwargs["group"] == SANDBOX_API_GROUP
        assert call_kwargs["plural"] == SANDBOX_PLURAL

    def test_get_sandbox_status(self, client):
        """Should return sandbox status information."""
        client.custom_api.get_namespaced_custom_object = MagicMock(
            return_value={
                "metadata": {
                    "name": "test-sandbox",
                    "annotations": {
                        "agents.x-k8s.io/pod-name": "test-pod",
                    },
                },
                "status": {
                    "conditions": [
                        {
                            "type": "Ready",
                            "status": "True",
                        }
                    ],
                    "podIP": "10.0.0.1",
                    "service": "test-sandbox",
                    "serviceFQDN": "test-sandbox.test-namespace.svc.cluster.local",
                },
            }
        )

        result = client.get_sandbox_status("test-sandbox")

        assert result["exists"] is True
        assert result["phase"] == "Running"
        assert result["pod_ip"] == "10.0.0.1"
        assert result["pod_name"] == "test-pod"
        assert result["service_fqdn"] == "test-sandbox.test-namespace.svc.cluster.local"

    def test_get_sandbox_status_not_found(self, client):
        """Should return not found status when sandbox doesn't exist."""
        client.custom_api.get_namespaced_custom_object = MagicMock(
            side_effect=ApiException(status=404)
        )

        result = client.get_sandbox_status("nonexistent")

        assert result["exists"] is False
        assert result["phase"] == "NotFound"


class TestSandboxTemplateOperations:
    """Tests for SandboxTemplate operations."""

    @pytest.fixture
    def client(self):
        """Create a WarmPoolClient instance."""
        mock_api_client = MagicMock()
        return WarmPoolClient(mock_api_client, "test-namespace")

    def test_create_sandbox_template(self, client):
        """Should create SandboxTemplate CR."""
        client.custom_api.create_namespaced_custom_object = MagicMock(
            return_value={"metadata": {"name": "test-template"}}
        )

        pod_template_spec = {"spec": {"containers": []}}
        result = client.create_sandbox_template(
            name="test-template",
            pod_template_spec=pod_template_spec,
        )

        client.custom_api.create_namespaced_custom_object.assert_called_once()

    def test_get_sandbox_template(self, client):
        """Should get SandboxTemplate."""
        expected = {"metadata": {"name": "test-template"}}
        client.custom_api.get_namespaced_custom_object = MagicMock(return_value=expected)

        result = client.get_sandbox_template("test-template")

        assert result == expected


class TestSandboxWarmPoolOperations:
    """Tests for SandboxWarmPool operations."""

    @pytest.fixture
    def client(self):
        """Create a WarmPoolClient instance."""
        mock_api_client = MagicMock()
        return WarmPoolClient(mock_api_client, "test-namespace")

    def test_create_sandbox_warmpool(self, client):
        """Should create SandboxWarmPool CR."""
        client.custom_api.create_namespaced_custom_object = MagicMock(
            return_value={"metadata": {"name": "test-warmpool"}}
        )

        result = client.create_sandbox_warmpool(
            name="test-warmpool",
            template_name="test-template",
            replicas=5,
            min_replicas=2,
            max_replicas=10,
        )

        client.custom_api.create_namespaced_custom_object.assert_called_once()
        call_kwargs = client.custom_api.create_namespaced_custom_object.call_args[1]
        body = call_kwargs["body"]
        assert body["spec"]["replicas"] == 5
        assert body["spec"]["scaling"]["minReplicas"] == 2
        assert body["spec"]["scaling"]["maxReplicas"] == 10

    def test_get_warmpool_status(self, client):
        """Should return warmpool status."""
        client.custom_api.get_namespaced_custom_object = MagicMock(
            return_value={
                "metadata": {"name": "test-warmpool"},
                "status": {
                    "availableReplicas": 3,
                    "replicas": 5,
                    "readyReplicas": 3,
                },
            }
        )

        result = client.get_warmpool_status("test-warmpool")

        assert result["exists"] is True
        assert result["available"] == 3
        assert result["total"] == 5
        assert result["ready"] == 3


class TestPodOperations:
    """Tests for Pod operations."""

    @pytest.fixture
    def client(self):
        """Create a WarmPoolClient instance."""
        mock_api_client = MagicMock()
        return WarmPoolClient(mock_api_client, "test-namespace")

    def test_patch_pod_metadata_with_labels_and_annotations(self, client):
        """Should patch pod with both labels and annotations."""
        client.core_api.patch_namespaced_pod = MagicMock(return_value=None)

        labels = {
            "aigc.weibo.com/executor-task-id": "12345",
        }
        annotations = {
            "aigc.weibo.com/heartbeat-enabled": "true",
        }
        result = client.patch_pod_metadata(
            pod_name="test-pod",
            labels=labels,
            annotations=annotations,
        )

        assert result is True
        client.core_api.patch_namespaced_pod.assert_called_once()
        call_kwargs = client.core_api.patch_namespaced_pod.call_args[1]
        assert call_kwargs["name"] == "test-pod"
        assert call_kwargs["namespace"] == "test-namespace"
        assert call_kwargs["body"]["metadata"]["labels"] == labels
        assert call_kwargs["body"]["metadata"]["annotations"] == annotations

    def test_patch_pod_metadata_with_labels_only(self, client):
        """Should patch pod with labels only."""
        client.core_api.patch_namespaced_pod = MagicMock(return_value=None)

        labels = {"aigc.weibo.com/executor-task-id": "12345"}
        result = client.patch_pod_metadata(
            pod_name="test-pod",
            labels=labels,
        )

        assert result is True
        call_kwargs = client.core_api.patch_namespaced_pod.call_args[1]
        assert "labels" in call_kwargs["body"]["metadata"]
        assert "annotations" not in call_kwargs["body"]["metadata"]

    def test_patch_pod_metadata_empty_returns_true(self, client):
        """Should return True when no labels or annotations provided."""
        client.core_api.patch_namespaced_pod = MagicMock(return_value=None)

        result = client.patch_pod_metadata(pod_name="test-pod")

        assert result is True
        client.core_api.patch_namespaced_pod.assert_not_called()

    def test_patch_pod_metadata_failure(self, client):
        """Should return False when patch fails."""
        client.core_api.patch_namespaced_pod = MagicMock(
            side_effect=ApiException(status=404)
        )

        result = client.patch_pod_metadata(
            pod_name="nonexistent-pod",
            labels={"key": "value"},
        )

        assert result is False

    def test_patch_pod_annotations_success(self, client):
        """Should patch pod annotations successfully (backward compatibility)."""
        client.core_api.patch_namespaced_pod = MagicMock(return_value=None)

        annotations = {
            "aigc.weibo.com/heartbeat-enabled": "true",
            "aigc.weibo.com/heartbeat-type": "sandbox",
        }
        result = client.patch_pod_annotations(
            pod_name="test-pod",
            annotations=annotations,
        )

        assert result is True
        client.core_api.patch_namespaced_pod.assert_called_once()
        call_kwargs = client.core_api.patch_namespaced_pod.call_args[1]
        assert call_kwargs["name"] == "test-pod"
        assert call_kwargs["namespace"] == "test-namespace"
        assert call_kwargs["body"]["metadata"]["annotations"] == annotations

    def test_patch_pod_annotations_failure(self, client):
        """Should return False when patch fails."""
        client.core_api.patch_namespaced_pod = MagicMock(
            side_effect=ApiException(status=404)
        )

        result = client.patch_pod_annotations(
            pod_name="nonexistent-pod",
            annotations={"key": "value"},
        )

        assert result is False
