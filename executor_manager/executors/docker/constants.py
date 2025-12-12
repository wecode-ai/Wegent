#!/usr/bin/env python

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# -*- coding: utf-8 -*-

"""
Constants definition file for Docker executor
"""

# Container owner identifier
import os

CONTAINER_OWNER = "executor_manager"

# Docker host configuration
DEFAULT_DOCKER_HOST = os.getenv("DOCKER_HOST_ADDR","host.docker.internal")
DOCKER_SOCKET_PATH = "/var/run/docker.sock"

# API configuration
DEFAULT_API_ENDPOINT = "/api/tasks/execute"

# Environment configuration
DEFAULT_TIMEZONE = "Asia/Shanghai"
DEFAULT_LOCALE = "en_US.UTF-8"

# Mount path
WORKSPACE_MOUNT_PATH = "/workspace"

# Task progress status
DEFAULT_PROGRESS_RUNNING = 30
DEFAULT_PROGRESS_COMPLETE = 100

# Default values
DEFAULT_TASK_ID = -1