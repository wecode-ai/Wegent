#!/usr/bin/env python

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# -*- coding: utf-8 -*-

"""
Tests for WorkspaceSetup class.
"""

import os
import shutil
import tempfile
from unittest.mock import MagicMock, patch

import pytest

from executor.workspace.workspace_setup import (TaskMetadata, WorkspaceResult,
                                                WorkspaceSetup,
                                                setup_workspace_for_task)


class TestWorkspaceSetup:
    """Test cases for WorkspaceSetup."""

    @pytest.fixture
    def temp_dir(self):
        """Create a temporary directory for tests."""
        temp = tempfile.mkdtemp()
        yield temp
        shutil.rmtree(temp, ignore_errors=True)

    @pytest.fixture
    def workspace_setup(self, temp_dir):
        """Create a WorkspaceSetup instance with temp directory."""
        return WorkspaceSetup(workspace_root=temp_dir)

    def test_init_creates_directories(self, temp_dir):
        """Test that initialization creates required directories."""
        setup = WorkspaceSetup(workspace_root=temp_dir)

        assert os.path.exists(os.path.join(temp_dir, "features"))
        assert os.path.exists(os.path.join(temp_dir, "tasks"))
        assert os.path.exists(os.path.join(temp_dir, "repos"))

    def test_setup_task_workspace_no_git(self, workspace_setup, temp_dir):
        """Test setting up task workspace without git URL."""
        result = workspace_setup.setup_workspace(
            task_id=123, git_url=None, branch_name=None, prompt="Test task"
        )

        assert result.success is True
        assert result.is_feature_workspace is False
        assert result.feature_name is None
        assert "task-123" in result.workspace_path
        assert os.path.exists(result.workspace_path)

    def test_setup_task_workspace_creates_metadata(self, workspace_setup, temp_dir):
        """Test that task workspace creates metadata file."""
        result = workspace_setup.setup_workspace(
            task_id=456, git_url=None, branch_name=None, prompt="Test prompt"
        )

        metadata_path = os.path.join(result.workspace_path, ".task.json")
        assert os.path.exists(metadata_path)

        # Load and verify metadata
        metadata = workspace_setup._load_task_metadata(result.workspace_path)
        assert metadata is not None
        assert metadata.task_id == 456
        assert metadata.prompt == "Test prompt"
        assert metadata.status == "running"

    @patch.object(WorkspaceSetup, "_clone_repo")
    def test_setup_task_workspace_with_git(self, mock_clone, workspace_setup, temp_dir):
        """Test setting up task workspace with git URL."""
        mock_clone.return_value = (True, None)

        result = workspace_setup.setup_workspace(
            task_id=789,
            git_url="https://github.com/org/repo.git",
            branch_name=None,
            prompt="Test task",
        )

        assert result.success is True
        assert result.is_feature_workspace is False
        assert "task-789" in result.workspace_path

    @patch("executor.workspace.feature_manager.FeatureManager.get_or_create_feature")
    def test_setup_feature_workspace(self, mock_feature, workspace_setup, temp_dir):
        """Test setting up feature workspace with feature_branch."""
        feature_path = os.path.join(temp_dir, "features", "feature-123")
        os.makedirs(feature_path, exist_ok=True)

        mock_feature.return_value = (True, feature_path, None)

        result = workspace_setup.setup_workspace(
            task_id=100,
            git_url="https://github.com/org/repo.git",
            branch_name="main",  # Source branch
            feature_branch="feature-123",  # Feature branch name for workspace
            prompt="Test feature",
        )

        assert result.success is True
        assert result.is_feature_workspace is True
        assert result.feature_name == "feature-123"

    def test_setup_feature_workspace_no_repos(self, workspace_setup, temp_dir):
        """Test setting up feature workspace without repositories."""
        result = workspace_setup.setup_workspace(
            task_id=200,
            git_url=None,
            branch_name=None,
            feature_branch="feature-empty",  # Feature branch name for workspace
            prompt="Empty feature",
        )

        assert result.success is True
        assert result.is_feature_workspace is True
        assert result.feature_name == "feature-empty"
        assert os.path.exists(os.path.join(result.workspace_path, "_workspace"))

    def test_cleanup_task_workspace(self, workspace_setup, temp_dir):
        """Test cleaning up task workspace."""
        # Create a task workspace first
        result = workspace_setup.setup_workspace(
            task_id=300, git_url=None, branch_name=None, prompt="To be cleaned"
        )

        assert os.path.exists(result.workspace_path)

        # Clean it up
        success = workspace_setup.cleanup_task_workspace(300)

        assert success is True
        assert not os.path.exists(result.workspace_path)

    def test_cleanup_nonexistent_task(self, workspace_setup):
        """Test cleaning up non-existent task workspace."""
        success = workspace_setup.cleanup_task_workspace(99999)
        assert success is False

    def test_get_workspace_info_task(self, workspace_setup, temp_dir):
        """Test getting workspace info for task."""
        # Create a task workspace
        workspace_setup.setup_workspace(
            task_id=400,
            git_url="https://github.com/org/repo.git",
            branch_name=None,
            prompt="Info test",
        )

        info = workspace_setup.get_workspace_info(400)

        assert info is not None
        assert info["type"] == "task"
        assert info["task_id"] == 400
        assert info["git_url"] == "https://github.com/org/repo.git"

    def test_get_workspace_info_nonexistent(self, workspace_setup):
        """Test getting workspace info for non-existent task."""
        info = workspace_setup.get_workspace_info(99999)
        assert info is None


class TestSetupWorkspaceForTask:
    """Test cases for setup_workspace_for_task convenience function."""

    @pytest.fixture
    def temp_dir(self):
        """Create a temporary directory for tests."""
        temp = tempfile.mkdtemp()
        yield temp
        shutil.rmtree(temp, ignore_errors=True)

    @patch("executor.workspace.workspace_setup.WorkspaceSetup")
    def test_setup_workspace_for_task(self, mock_setup_class):
        """Test the convenience function extracts parameters correctly."""
        mock_instance = MagicMock()
        mock_instance.setup_workspace.return_value = WorkspaceResult(
            success=True,
            workspace_path="/test/path",
            project_path="/test/path/repo",
            feature_name=None,
            error_message=None,
            is_feature_workspace=False,
        )
        mock_setup_class.return_value = mock_instance

        task_data = {
            "task_id": 500,
            "git_url": "https://github.com/org/repo.git",
            "branch_name": "feature-test",
            "prompt": "Test prompt",
            "user": {"git_token": "test_token", "git_login": "test_user"},
        }

        result = setup_workspace_for_task(task_data)

        assert result.success is True
        mock_instance.setup_workspace.assert_called_once_with(
            task_id=500,
            git_url="https://github.com/org/repo.git",
            branch_name="feature-test",
            feature_branch=None,
            prompt="Test prompt",
            git_token="test_token",
            git_login="test_user",
            additional_repos=None,
        )


class TestWorkspaceResult:
    """Test cases for WorkspaceResult dataclass."""

    def test_workspace_result_creation(self):
        """Test creating WorkspaceResult."""
        result = WorkspaceResult(
            success=True,
            workspace_path="/test/path",
            project_path="/test/path/repo",
            feature_name="feature-123",
            error_message=None,
            is_feature_workspace=True,
        )

        assert result.success is True
        assert result.workspace_path == "/test/path"
        assert result.project_path == "/test/path/repo"
        assert result.feature_name == "feature-123"
        assert result.error_message is None
        assert result.is_feature_workspace is True

    def test_workspace_result_failure(self):
        """Test creating failed WorkspaceResult."""
        result = WorkspaceResult(
            success=False,
            workspace_path="",
            project_path=None,
            feature_name=None,
            error_message="Clone failed",
            is_feature_workspace=False,
        )

        assert result.success is False
        assert result.error_message == "Clone failed"


class TestTaskMetadata:
    """Test cases for TaskMetadata dataclass."""

    def test_task_metadata_creation(self):
        """Test creating TaskMetadata."""
        metadata = TaskMetadata(
            task_id=123,
            created_at="2024-01-15T10:00:00",
            feature_name="feature-123",
            status="running",
            prompt="Test prompt",
            git_url="https://github.com/org/repo.git",
            branch_name="feature-123",
        )

        assert metadata.task_id == 123
        assert metadata.feature_name == "feature-123"
        assert metadata.status == "running"
        assert metadata.prompt == "Test prompt"
