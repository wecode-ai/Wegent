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

from app.models.flow import FlowExecution, FlowResource
from app.models.kind import Kind
from app.schemas.flow import FlowExecutionStatus, FlowTaskType, FlowTriggerType


class TestFlowEndpoints:
    """Test Flow API endpoints."""

    @pytest.fixture
    def test_team(self, db_session, test_user):
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
        db_session.add(team)
        db_session.commit()
        db_session.refresh(team)
        return team

    @pytest.fixture
    def test_flow(self, db_session, test_user, test_team):
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
        )
        db_session.add(flow)
        db_session.commit()
        db_session.refresh(flow)
        return flow

    def test_create_flow(self, client, test_user, test_team, auth_headers):
        """Test creating a new flow."""
        response = client.post(
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
            headers=auth_headers,
        )
        assert response.status_code == status.HTTP_201_CREATED
        data = response.json()
        assert data["name"] == "new-flow"
        assert data["display_name"] == "New Flow"
        assert data["enabled"] == True

    def test_list_flows(self, client, test_flow, auth_headers):
        """Test listing flows."""
        response = client.get("/api/flows", headers=auth_headers)
        assert response.status_code == status.HTTP_200_OK
        data = response.json()
        assert data["total"] >= 1
        assert len(data["items"]) >= 1

    def test_get_flow(self, client, test_flow, auth_headers):
        """Test getting a specific flow."""
        response = client.get(f"/api/flows/{test_flow.id}", headers=auth_headers)
        assert response.status_code == status.HTTP_200_OK
        data = response.json()
        assert data["id"] == test_flow.id
        assert data["name"] == "test-flow"

    def test_update_flow(self, client, test_flow, auth_headers):
        """Test updating a flow."""
        response = client.put(
            f"/api/flows/{test_flow.id}",
            json={"display_name": "Updated Flow Name", "enabled": False},
            headers=auth_headers,
        )
        assert response.status_code == status.HTTP_200_OK
        data = response.json()
        assert data["display_name"] == "Updated Flow Name"
        assert data["enabled"] == False

    def test_delete_flow(self, client, test_flow, auth_headers):
        """Test deleting a flow."""
        response = client.delete(f"/api/flows/{test_flow.id}", headers=auth_headers)
        assert response.status_code == status.HTTP_204_NO_CONTENT

        # Verify soft delete
        response = client.get(f"/api/flows/{test_flow.id}", headers=auth_headers)
        assert response.status_code == status.HTTP_404_NOT_FOUND

    def test_toggle_flow(self, client, test_flow, auth_headers):
        """Test toggling flow enabled/disabled."""
        # Disable
        response = client.post(
            f"/api/flows/{test_flow.id}/toggle?enabled=false", headers=auth_headers
        )
        assert response.status_code == status.HTTP_200_OK
        assert response.json()["enabled"] == False

        # Enable
        response = client.post(
            f"/api/flows/{test_flow.id}/toggle?enabled=true", headers=auth_headers
        )
        assert response.status_code == status.HTTP_200_OK
        assert response.json()["enabled"] == True

    def test_trigger_flow(self, client, test_flow, auth_headers):
        """Test manually triggering a flow."""
        response = client.post(
            f"/api/flows/{test_flow.id}/trigger", headers=auth_headers
        )
        assert response.status_code == status.HTTP_200_OK
        data = response.json()
        assert data["flow_id"] == test_flow.id
        assert data["trigger_type"] == "manual"
        assert data["status"] == "PENDING"

    def test_create_flow_without_team(self, client, auth_headers):
        """Test creating flow without valid team fails."""
        response = client.post(
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
            headers=auth_headers,
        )
        assert response.status_code == status.HTTP_400_BAD_REQUEST


class TestFlowExecutionEndpoints:
    """Test Flow Execution API endpoints."""

    @pytest.fixture
    def test_team(self, db_session, test_user):
        """Create a test team."""
        team = Kind(
            user_id=test_user.id,
            kind="Team",
            name="test-team",
            namespace="default",
            json={"apiVersion": "agent.wecode.io/v1", "kind": "Team"},
            is_active=True,
        )
        db_session.add(team)
        db_session.commit()
        db_session.refresh(team)
        return team

    @pytest.fixture
    def test_flow(self, db_session, test_user, test_team):
        """Create a test flow."""
        flow = FlowResource(
            user_id=test_user.id,
            kind="Flow",
            name="test-flow",
            namespace="default",
            json={
                "apiVersion": "agent.wecode.io/v1",
                "kind": "Flow",
                "spec": {
                    "displayName": "Test Flow",
                    "taskType": "collection",
                    "trigger": {"type": "cron", "cron": {"expression": "0 9 * * *"}},
                    "teamRef": {"name": "test-team"},
                    "promptTemplate": "Test",
                },
            },
            is_active=True,
            enabled=True,
            trigger_type="cron",
            team_id=test_team.id,
        )
        db_session.add(flow)
        db_session.commit()
        db_session.refresh(flow)
        return flow

    @pytest.fixture
    def test_execution(self, db_session, test_user, test_flow):
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
        db_session.add(execution)
        db_session.commit()
        db_session.refresh(execution)
        return execution

    def test_list_executions(self, client, test_execution, auth_headers):
        """Test listing executions."""
        response = client.get("/api/flows/executions", headers=auth_headers)
        assert response.status_code == status.HTTP_200_OK
        data = response.json()
        assert data["total"] >= 1
        assert len(data["items"]) >= 1

    def test_get_execution(self, client, test_execution, auth_headers):
        """Test getting a specific execution."""
        response = client.get(
            f"/api/flows/executions/{test_execution.id}", headers=auth_headers
        )
        assert response.status_code == status.HTTP_200_OK
        data = response.json()
        assert data["id"] == test_execution.id
        assert data["status"] == "COMPLETED"

    def test_list_executions_with_filters(
        self, client, test_flow, test_execution, auth_headers
    ):
        """Test listing executions with filters."""
        # Filter by flow_id
        response = client.get(
            f"/api/flows/executions?flow_id={test_flow.id}", headers=auth_headers
        )
        assert response.status_code == status.HTTP_200_OK
        data = response.json()
        assert all(item["flow_id"] == test_flow.id for item in data["items"])

        # Filter by status
        response = client.get(
            "/api/flows/executions?status=COMPLETED", headers=auth_headers
        )
        assert response.status_code == status.HTTP_200_OK
