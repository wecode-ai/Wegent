# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for cancel_execution with task cancellation."""

from datetime import datetime, timezone
from unittest.mock import MagicMock, patch

import pytest

from app.models.subscription import BackgroundExecution
from app.models.subtask import Subtask, SubtaskStatus
from app.models.task import TaskResource
from app.schemas.subscription import BackgroundExecutionStatus
from app.services.subscription.execution import background_execution_manager


def create_task_json(status="RUNNING", progress=0, completed_at=None):
    """Create a valid Task JSON with all required fields."""
    status_obj = {
        "status": status,
        "progress": progress,
        "updatedAt": datetime.now().isoformat(),
    }
    if completed_at:
        status_obj["completedAt"] = completed_at

    return {
        "apiVersion": "agent.wecode.io/v1",
        "kind": "Task",
        "spec": {
            "title": "Test Task",
            "prompt": "Test prompt",
            "teamRef": {"name": "test-team", "namespace": "default", "user_id": 1},
            "workspaceRef": {"name": "test-workspace", "namespace": "default"},
        },
        "status": status_obj,
        "metadata": {"name": "test-task", "namespace": "default"},
    }


class TestCancelExecutionWithTask:
    """Tests that cancel_execution properly cancels associated tasks."""

    def test_cancel_execution_updates_task_status(self, test_db, test_user):
        """Test that cancel_execution updates associated task status to CANCELLED."""
        # Create a task with valid JSON
        task = TaskResource(
            user_id=test_user.id,
            kind="Task",
            name="test-task",
            namespace="default",
            json=create_task_json(status="RUNNING", progress=50),
            is_active=TaskResource.STATE_ACTIVE,
        )
        test_db.add(task)
        test_db.commit()
        test_db.refresh(task)

        # Create an execution with task_id
        execution = BackgroundExecution(
            user_id=test_user.id,
            subscription_id=1,
            task_id=task.id,
            trigger_type="manual",
            trigger_reason="Test",
            prompt="Test prompt",
            status=BackgroundExecutionStatus.RUNNING.value,
            retry_attempt=0,
        )
        test_db.add(execution)
        test_db.commit()
        test_db.refresh(execution)

        # Cancel the execution
        result = background_execution_manager.cancel_execution(
            test_db, execution_id=execution.id, user_id=test_user.id
        )

        # Verify execution status
        assert result.status == BackgroundExecutionStatus.CANCELLED

        # Verify task status is updated
        test_db.refresh(task)
        task_crd = task.json
        assert task_crd["status"]["status"] == "CANCELLED"

    def test_cancel_execution_updates_subtasks(self, test_db, test_user):
        """Test that cancel_execution updates running subtasks to CANCELLED."""
        # Create a task with valid JSON
        task = TaskResource(
            user_id=test_user.id,
            kind="Task",
            name="test-task",
            namespace="default",
            json=create_task_json(status="RUNNING"),
            is_active=TaskResource.STATE_ACTIVE,
        )
        test_db.add(task)
        test_db.commit()
        test_db.refresh(task)

        # Create running subtasks with all required fields
        from datetime import datetime

        from app.models.subtask import SubtaskRole

        placeholder_date = datetime(1970, 1, 1)
        subtask1 = Subtask(
            task_id=task.id,
            user_id=test_user.id,
            team_id=1,
            title="Test subtask 1",
            bot_ids=[],
            role=SubtaskRole.ASSISTANT,
            status=SubtaskStatus.RUNNING,
            progress=50,
            completed_at=placeholder_date,
            executor_namespace="",
            executor_name="",
            prompt="",
            message_id=1,
            sender_type="",
            sender_user_id=0,
            reply_to_subtask_id=0,
        )
        subtask2 = Subtask(
            task_id=task.id,
            user_id=test_user.id,
            team_id=1,
            title="Test subtask 2",
            bot_ids=[],
            role=SubtaskRole.ASSISTANT,
            status=SubtaskStatus.PENDING,
            progress=0,
            completed_at=placeholder_date,
            executor_namespace="",
            executor_name="",
            prompt="",
            message_id=1,
            sender_type="",
            sender_user_id=0,
            reply_to_subtask_id=0,
        )
        test_db.add(subtask1)
        test_db.add(subtask2)
        test_db.commit()

        # Create an execution with task_id
        execution = BackgroundExecution(
            user_id=test_user.id,
            subscription_id=1,
            task_id=task.id,
            trigger_type="manual",
            trigger_reason="Test",
            prompt="Test prompt",
            status=BackgroundExecutionStatus.RUNNING.value,
            retry_attempt=0,
        )
        test_db.add(execution)
        test_db.commit()
        test_db.refresh(execution)

        # Cancel the execution
        background_execution_manager.cancel_execution(
            test_db, execution_id=execution.id, user_id=test_user.id
        )

        # Verify subtasks are cancelled
        test_db.refresh(subtask1)
        test_db.refresh(subtask2)
        assert subtask1.status == SubtaskStatus.CANCELLED
        assert subtask2.status == SubtaskStatus.CANCELLED
        assert subtask1.progress == 100
        assert subtask2.progress == 100

    def test_cancel_execution_without_task_id(self, test_db, test_user):
        """Test that cancel_execution works when no task is associated."""
        # Create an execution without task_id (task_id=0)
        execution = BackgroundExecution(
            user_id=test_user.id,
            subscription_id=1,
            task_id=0,  # No task
            trigger_type="manual",
            trigger_reason="Test",
            prompt="Test prompt",
            status=BackgroundExecutionStatus.PENDING.value,
            retry_attempt=0,
        )
        test_db.add(execution)
        test_db.commit()
        test_db.refresh(execution)

        # Cancel should work without error
        result = background_execution_manager.cancel_execution(
            test_db, execution_id=execution.id, user_id=test_user.id
        )

        assert result.status == BackgroundExecutionStatus.CANCELLED

    def test_cancel_execution_skips_terminal_state_tasks(self, test_db, test_user):
        """Test that cancel_execution skips tasks already in terminal state."""
        # Create a completed task
        completed_time = datetime.now().isoformat()
        task = TaskResource(
            user_id=test_user.id,
            kind="Task",
            name="test-task",
            namespace="default",
            json=create_task_json(
                status="COMPLETED", progress=100, completed_at=completed_time
            ),
            is_active=TaskResource.STATE_ACTIVE,
        )
        test_db.add(task)
        test_db.commit()
        test_db.refresh(task)

        # Create an execution with task_id
        execution = BackgroundExecution(
            user_id=test_user.id,
            subscription_id=1,
            task_id=task.id,
            trigger_type="manual",
            trigger_reason="Test",
            prompt="Test prompt",
            status=BackgroundExecutionStatus.RUNNING.value,
            retry_attempt=0,
        )
        test_db.add(execution)
        test_db.commit()
        test_db.refresh(execution)

        # Cancel the execution
        background_execution_manager.cancel_execution(
            test_db, execution_id=execution.id, user_id=test_user.id
        )

        # Verify task status is still COMPLETED (not changed)
        test_db.refresh(task)
        task_crd = task.json
        assert task_crd["status"]["status"] == "COMPLETED"
        assert task_crd["status"]["completedAt"] == completed_time
