#!/usr/bin/env python

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# -*- coding: utf-8 -*-

"""
Configuration module, stores application configuration parameters
"""

# API Configuration
# API Configuration
import os


TASK_API_DOMAIN = os.getenv("TASK_API_DOMAIN", "http://localhost:8000")

# Task fetch parameters
TASK_FETCH_LIMIT = 1
TASK_FETCH_STATUS = "PENDING"

# API URLs
FETCH_TASK_API_BASE_URL = TASK_API_DOMAIN + "/api/executors/tasks/dispatch"
CALLBACK_TASK_API_URL = TASK_API_DOMAIN + "/api/executors/tasks"
API_TIMEOUT = 3  # API request timeout (seconds)
API_MAX_RETRIES = 3  # Maximum number of retry attempts
API_RETRY_DELAY = 1  # Initial delay between retries (seconds)
API_RETRY_BACKOFF = 2  # Backoff multiplier for retry delay

# Scheduler Configuration
TASK_FETCH_INTERVAL = 5  # Task fetch interval (seconds)
TIME_LOG_INTERVAL = 5  # Time log interval (seconds)
SCHEDULER_SLEEP_TIME = 1  # Scheduler sleep time (seconds)


# Define port range for Docker containers
PORT_RANGE_MIN = int(os.getenv("EXECUTOR_PORT_RANGE_MIN", 10000))
PORT_RANGE_MAX = int(os.getenv("EXECUTOR_PORT_RANGE_MAX", 10100))

# GitHub App Configuration
GITHUB_APP_ID = os.getenv("GITHUB_APP_ID")
GITHUB_PRIVATE_KEY_PATH = os.getenv("GITHUB_PRIVATE_KEY_PATH")
GITHUB_PRIVATE_KEY = os.getenv("GITHUB_PRIVATE_KEY")

EXECUTOR_DISPATCHER_MODE = os.getenv("EXECUTOR_DISPATCHER_MODE", "docker")
EXECUTOR_CONFIG = os.getenv("EXECUTOR_CONFIG", "{\"docker\":\"executor_manager.executors.docker.DockerExecutor\"}")
EXECUTOR_ENV = os.environ.get("EXECUTOR_ENV", "{\"DEFAULT_HEADERS\":{\"wecode-user\":\"${task_data.user.name}\",\"wecode-action\":\"wegent\",\"wecode-model-id\":\"${agent_config.env.model_id}\"}}")
