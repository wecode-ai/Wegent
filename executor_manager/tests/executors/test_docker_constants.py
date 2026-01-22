# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import pytest

from executor_manager.executors.docker.constants import (
    CONTAINER_OWNER,
    DEFAULT_API_ENDPOINT,
    DEFAULT_DOCKER_HOST,
    DEFAULT_LOCALE,
    DEFAULT_PROGRESS_COMPLETE,
    DEFAULT_PROGRESS_RUNNING,
    DEFAULT_TASK_ID,
    DEFAULT_TIMEZONE,
    DOCKER_SOCKET_PATH,
    WORKSPACE_MOUNT_PATH,
)


class TestDockerConstants:
    """Test cases for Docker constants"""

    def test_container_owner(self):
        """Test CONTAINER_OWNER constant"""
        assert CONTAINER_OWNER == "executor_manager"
        assert isinstance(CONTAINER_OWNER, str)

    def test_default_docker_host(self):
        """Test DEFAULT_DOCKER_HOST constant"""
        assert DEFAULT_DOCKER_HOST == "host.docker.internal"
        assert isinstance(DEFAULT_DOCKER_HOST, str)

    def test_docker_socket_path(self):
        """Test DOCKER_SOCKET_PATH constant"""
        assert DOCKER_SOCKET_PATH == "/var/run/docker.sock"
        assert isinstance(DOCKER_SOCKET_PATH, str)

    def test_default_api_endpoint(self):
        """Test DEFAULT_API_ENDPOINT constant"""
        assert DEFAULT_API_ENDPOINT == "/api/tasks/execute"
        assert isinstance(DEFAULT_API_ENDPOINT, str)
        assert DEFAULT_API_ENDPOINT.startswith("/")

    def test_default_timezone(self):
        """Test DEFAULT_TIMEZONE constant"""
        assert DEFAULT_TIMEZONE == "Asia/Shanghai"
        assert isinstance(DEFAULT_TIMEZONE, str)

    def test_default_locale(self):
        """Test DEFAULT_LOCALE constant"""
        assert DEFAULT_LOCALE == "en_US.UTF-8"
        assert isinstance(DEFAULT_LOCALE, str)

    def test_workspace_mount_path(self):
        """Test WORKSPACE_MOUNT_PATH constant"""
        assert WORKSPACE_MOUNT_PATH == "/workspace"
        assert isinstance(WORKSPACE_MOUNT_PATH, str)
        assert WORKSPACE_MOUNT_PATH.startswith("/")

    def test_default_progress_running(self):
        """Test DEFAULT_PROGRESS_RUNNING constant"""
        assert DEFAULT_PROGRESS_RUNNING == 30
        assert isinstance(DEFAULT_PROGRESS_RUNNING, int)
        assert 0 <= DEFAULT_PROGRESS_RUNNING <= 100

    def test_default_progress_complete(self):
        """Test DEFAULT_PROGRESS_COMPLETE constant"""
        assert DEFAULT_PROGRESS_COMPLETE == 100
        assert isinstance(DEFAULT_PROGRESS_COMPLETE, int)
        assert DEFAULT_PROGRESS_COMPLETE == 100

    def test_default_task_id(self):
        """Test DEFAULT_TASK_ID constant"""
        assert DEFAULT_TASK_ID == -1
        assert isinstance(DEFAULT_TASK_ID, int)

    def test_progress_values_relationship(self):
        """Test that progress values have correct relationship"""
        assert DEFAULT_PROGRESS_RUNNING < DEFAULT_PROGRESS_COMPLETE
        assert DEFAULT_PROGRESS_RUNNING >= 0
        assert DEFAULT_PROGRESS_COMPLETE <= 100
