# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Tests for Flow API endpoints.
"""
import json
from datetime import datetime, timedelta
from unittest.mock import patch

import pytest
from fastapi import status
from fastapi.testclient import TestClient

from app.models.flow import FlowExecution, FlowResource
from app.models.kind import Kind
from app.models.user import User
from app.schemas.flow import FlowExecutionStatus, FlowTaskType, FlowTriggerType


class TestFlowEndpoints:
    """Test Flow API endpoints."""

    @pytest.fixture
    def test_team(self, test_db, test_user):
        """Create a test team."""
        team = Kind(
            user_id=test_user.id,
            kind="Team",
            name="test-team",
            namespace="default",
            json={
                "apiVersion": "agent.wecode.io/v1",
                "kind": "Team",
                "metadata": {"name": "test-team", "namespace": "default"},
                "spec": {"displayName": "Test Team", "members": []},
            },
            is_active=True,
        )
        test_db.add(team)
        test_db.commit()
        test_db.refresh(team)
        return team

    @pytest.fixture
    def test_flow(self, test_db, test_user, test_team):
        """Create a test flow."""
        flow_json = {
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Flow",
            "metadata": {"name": "test-flow", "namespace": "default"},
            "spec": {
                "displayName": "Test Flow",
                "taskType": "collection",
                "trigger": {
                    "type": "cron",
                    "cron": {"expression": "0 9 * * *", "timezone": "UTC"},
                },
                "teamRef": {"name": "test-team", "namespace": "default"},
                "promptTemplate": "Test prompt",
                "retryCount": 0,
                "enabled": True,
            },
            "status": {"state": "Available"},
        }
        now = datetime.utcnow()
        flow = FlowResource(
            user_id=test_user.id,
            kind="Flow",
            name="test-flow",
            namespace="default",
            json=flow_json,
            is_active=True,
            enabled=True,
            trigger_type="cron",
            team_id=test_team.id,
            last_execution_time=now,
            last_execution_status="",
            next_execution_time=now + timedelta(days=1),
        )
        test_db.add(flow)
        test_db.commit()
        test_db.refresh(flow)
        return flow

    def test_create_flow(
        self, test_client: TestClient, test_user: User, test_team, test_token: str
    ):
        """Test creating a new flow."""
        response = test_client.post(
            "/api/flows",
            json={
                "name": "new-flow",
                "display_name": "New Flow",
                "task_type": "collection",
                "trigger_type": "cron",
                "trigger_config": {"expression": "0 9 * * *", "timezone": "UTC"},
                "team_id": test_team.id,
                "prompt_template": "Test prompt {{date}}",
                "retry_count": 1,
                "enabled": True,
            },
            headers={"Authorization": f"Bearer {test_token}"},
        )
        assert response.status_code == status.HTTP_201_CREATED
        data = response.json()
        assert data["name"] == "new-flow"
        assert data["display_name"] == "New Flow"
        assert data["enabled"] == True

    def test_list_flows(self, test_client: TestClient, test_flow, test_token: str):
        """Test listing flows."""
        response = test_client.get(
            "/api/flows", headers={"Authorization": f"Bearer {test_token}"}
        )
        assert response.status_code == status.HTTP_200_OK
        data = response.json()
        assert data["total"] >= 1
        assert len(data["items"]) >= 1

    def test_get_flow(self, test_client: TestClient, test_flow, test_token: str):
        """Test getting a specific flow."""
        response = test_client.get(
            f"/api/flows/{test_flow.id}",
            headers={"Authorization": f"Bearer {test_token}"},
        )
        assert response.status_code == status.HTTP_200_OK
        data = response.json()
        assert data["id"] == test_flow.id
        assert data["name"] == "test-flow"

    def test_update_flow(self, test_client: TestClient, test_flow, test_token: str):
        """Test updating a flow."""
        response = test_client.put(
            f"/api/flows/{test_flow.id}",
            json={"display_name": "Updated Flow Name", "enabled": False},
            headers={"Authorization": f"Bearer {test_token}"},
        )
        assert response.status_code == status.HTTP_200_OK
        data = response.json()
        assert data["display_name"] == "Updated Flow Name"
        assert data["enabled"] == False

    def test_delete_flow(self, test_client: TestClient, test_flow, test_token: str):
        """Test deleting a flow."""
        response = test_client.delete(
            f"/api/flows/{test_flow.id}",
            headers={"Authorization": f"Bearer {test_token}"},
        )
        assert response.status_code == status.HTTP_204_NO_CONTENT

        # Verify soft delete
        response = test_client.get(
            f"/api/flows/{test_flow.id}",
            headers={"Authorization": f"Bearer {test_token}"},
        )
        assert response.status_code == status.HTTP_404_NOT_FOUND

    def test_toggle_flow(self, test_client: TestClient, test_flow, test_token: str):
        """Test toggling flow enabled/disabled."""
        # Disable
        response = test_client.post(
            f"/api/flows/{test_flow.id}/toggle?enabled=false",
            headers={"Authorization": f"Bearer {test_token}"},
        )
        assert response.status_code == status.HTTP_200_OK
        assert response.json()["enabled"] == False

        # Enable
        response = test_client.post(
            f"/api/flows/{test_flow.id}/toggle?enabled=true",
            headers={"Authorization": f"Bearer {test_token}"},
        )
        assert response.status_code == status.HTTP_200_OK
        assert response.json()["enabled"] == True

    @patch("app.tasks.flow_tasks.execute_flow_task.apply_async")
    def test_trigger_flow(
        self, mock_apply_async, test_client: TestClient, test_flow, test_token: str
    ):
        """Test manually triggering a flow."""
        # Mock Celery task to avoid Redis connection
        mock_apply_async.return_value = None

        response = test_client.post(
            f"/api/flows/{test_flow.id}/trigger",
            headers={"Authorization": f"Bearer {test_token}"},
        )
        assert response.status_code == status.HTTP_200_OK
        data = response.json()
        assert data["flow_id"] == test_flow.id
        assert data["trigger_type"] == "manual"
        assert data["status"] == "PENDING"

        # Verify Celery task was called
        mock_apply_async.assert_called_once()

    def test_create_flow_without_team(self, test_client: TestClient, test_token: str):
        """Test creating flow without valid team fails."""
        response = test_client.post(
            "/api/flows",
            json={
                "name": "invalid-flow",
                "display_name": "Invalid Flow",
                "task_type": "collection",
                "trigger_type": "cron",
                "trigger_config": {"expression": "0 9 * * *"},
                "team_id": 99999,  # Non-existent team
                "prompt_template": "Test",
            },
            headers={"Authorization": f"Bearer {test_token}"},
        )
        assert response.status_code == status.HTTP_400_BAD_REQUEST


class TestFlowExecutionEndpoints:
    """Test Flow Execution API endpoints."""

    @pytest.fixture
    def test_team(self, test_db, test_user):
        """Create a test team."""
        team = Kind(
            user_id=test_user.id,
            kind="Team",
            name="test-team-exec",
            namespace="default",
            json={"apiVersion": "agent.wecode.io/v1", "kind": "Team"},
            is_active=True,
        )
        test_db.add(team)
        test_db.commit()
        test_db.refresh(team)
        return team

    @pytest.fixture
    def test_flow(self, test_db, test_user, test_team):
        """Create a test flow."""
        now = datetime.utcnow()
        flow = FlowResource(
            user_id=test_user.id,
            kind="Flow",
            name="test-flow-exec",
            namespace="default",
            json={
                "apiVersion": "agent.wecode.io/v1",
                "kind": "Flow",
                "metadata": {"name": "test-flow-exec", "namespace": "default"},
                "spec": {
                    "displayName": "Test Flow",
                    "taskType": "collection",
                    "trigger": {"type": "cron", "cron": {"expression": "0 9 * * *"}},
                    "teamRef": {"name": "test-team-exec", "namespace": "default"},
                    "promptTemplate": "Test",
                },
            },
            is_active=True,
            enabled=True,
            trigger_type="cron",
            team_id=test_team.id,
            last_execution_time=now,
            last_execution_status="",
            next_execution_time=now + timedelta(days=1),
        )
        test_db.add(flow)
        test_db.commit()
        test_db.refresh(flow)
        return flow

    @pytest.fixture
    def test_execution(self, test_db, test_user, test_flow):
        """Create a test execution."""
        execution = FlowExecution(
            user_id=test_user.id,
            flow_id=test_flow.id,
            trigger_type="cron",
            trigger_reason="Scheduled execution",
            prompt="Test prompt",
            status="COMPLETED",
            result_summary="Test completed successfully",
            started_at=datetime.utcnow() - timedelta(minutes=5),
            completed_at=datetime.utcnow(),
        )
        test_db.add(execution)
        test_db.commit()
        test_db.refresh(execution)
        return execution

    def test_list_executions(
        self, test_client: TestClient, test_execution, test_token: str
    ):
        """Test listing executions."""
        response = test_client.get(
            "/api/flows/executions",
            headers={"Authorization": f"Bearer {test_token}"},
        )
        assert response.status_code == status.HTTP_200_OK
        data = response.json()
        assert data["total"] >= 1
        assert len(data["items"]) >= 1

    def test_get_execution(
        self, test_client: TestClient, test_execution, test_token: str
    ):
        """Test getting a specific execution."""
        response = test_client.get(
            f"/api/flows/executions/{test_execution.id}",
            headers={"Authorization": f"Bearer {test_token}"},
        )
        assert response.status_code == status.HTTP_200_OK
        data = response.json()
        assert data["id"] == test_execution.id
        assert data["status"] == "COMPLETED"

    def test_list_executions_with_filters(
        self, test_client: TestClient, test_flow, test_execution, test_token: str
    ):
        """Test listing executions with filters."""
        # Filter by flow_id
        response = test_client.get(
            f"/api/flows/executions?flow_id={test_flow.id}",
            headers={"Authorization": f"Bearer {test_token}"},
        )
        assert response.status_code == status.HTTP_200_OK
        data = response.json()
        assert all(item["flow_id"] == test_flow.id for item in data["items"])

        # Filter by status
        response = test_client.get(
            "/api/flows/executions?status=COMPLETED",
            headers={"Authorization": f"Bearer {test_token}"},
        )
        assert response.status_code == status.HTTP_200_OK
