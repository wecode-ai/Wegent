#!/usr/bin/env python

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# -*- coding: utf-8 -*-

"""
Configuration module, stores application configuration parameters
"""

# API Configuration
import os

TASK_API_DOMAIN = os.getenv("TASK_API_DOMAIN", "http://localhost:8000")

# API timeout
API_TIMEOUT = 3  # API request timeout (seconds)

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

# Sandbox configuration
# Default timeout for Sandbox task execution (seconds)
SANDBOX_DEFAULT_TIMEOUT = int(os.getenv("SANDBOX_DEFAULT_TIMEOUT", "600"))
# Redis cache TTL for Sandbox task state (seconds, 24 hours)
SANDBOX_REDIS_TTL = int(os.getenv("SANDBOX_REDIS_TTL", "86400"))
# Maximum concurrent Sandbox tasks per user
SANDBOX_MAX_CONCURRENT = int(os.getenv("SANDBOX_MAX_CONCURRENT", "5"))

# Offline task queue time window configuration
# Evening hours: 21-23 means hours 21, 22, 23 (9 PM - 11:59 PM)
OFFLINE_TASK_EVENING_HOURS = os.getenv("OFFLINE_TASK_EVENING_HOURS", "21-23")
# Morning hours: 0-8 means hours 0, 1, 2, 3, 4, 5, 6, 7, 8 (12 AM - 8:59 AM)
OFFLINE_TASK_MORNING_HOURS = os.getenv("OFFLINE_TASK_MORNING_HOURS", "0-8")

# OpenTelemetry configuration is centralized in shared/telemetry/config.py
# Use: from shared.telemetry.config import get_otel_config
# All OTEL_* environment variables are read from there
