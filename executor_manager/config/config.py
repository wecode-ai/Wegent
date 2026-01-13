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
OFFLINE_TASK_FETCH_LIMIT = 5

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

# Offline task scheduling time configuration
# Evening time range for offline tasks (default: 21-23)
OFFLINE_TASK_EVENING_HOURS = os.getenv("OFFLINE_TASK_EVENING_HOURS", "21-23")

# Early morning time range for offline tasks (default: 0-8)
OFFLINE_TASK_MORNING_HOURS = os.getenv("OFFLINE_TASK_MORNING_HOURS", "0-8")


# Define port range for Docker containers
PORT_RANGE_MIN = int(os.getenv("EXECUTOR_PORT_RANGE_MIN", 10000))
PORT_RANGE_MAX = int(os.getenv("EXECUTOR_PORT_RANGE_MAX", 10100))

# GitHub App Configuration
GITHUB_APP_ID = os.getenv("GITHUB_APP_ID")
GITHUB_PRIVATE_KEY_PATH = os.getenv("GITHUB_PRIVATE_KEY_PATH")
GITHUB_PRIVATE_KEY = os.getenv("GITHUB_PRIVATE_KEY")

EXECUTOR_DISPATCHER_MODE = os.getenv("EXECUTOR_DISPATCHER_MODE", "docker")
EXECUTOR_CONFIG = os.getenv(
    "EXECUTOR_CONFIG", '{"docker":"executor_manager.executors.docker.DockerExecutor"}'
)
EXECUTOR_ENV = os.environ.get("EXECUTOR_ENV", "{}")

# SubAgent configuration
# Default timeout for SubAgent task execution (seconds)
SUBAGENT_DEFAULT_TIMEOUT = int(os.getenv("SUBAGENT_DEFAULT_TIMEOUT", "600"))
# Redis cache TTL for SubAgent task state (seconds, 24 hours)
SUBAGENT_REDIS_TTL = int(os.getenv("SUBAGENT_REDIS_TTL", "86400"))
# Maximum concurrent SubAgent tasks per user
SUBAGENT_MAX_CONCURRENT = int(os.getenv("SUBAGENT_MAX_CONCURRENT", "5"))

# OpenTelemetry configuration is centralized in shared/telemetry/config.py
# Use: from shared.telemetry.config import get_otel_config
# All OTEL_* environment variables are read from there
