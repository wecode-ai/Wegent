#!/usr/bin/env python

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# -*- coding: utf-8 -*-

"""
常量定义文件，用于Docker执行器
"""

# 容器所有者标识
CONTAINER_OWNER = "executor_manager"

# Docker主机配置
DEFAULT_DOCKER_HOST = "host.docker.internal"
DOCKER_SOCKET_PATH = "/var/run/docker.sock"

# API配置
DEFAULT_API_ENDPOINT = "/api/tasks/execute"

# 环境配置
DEFAULT_TIMEZONE = "Asia/Shanghai"
DEFAULT_LOCALE = "en_US.UTF-8"

# 挂载路径
WORKSPACE_MOUNT_PATH = "/workspace"

# 任务进度状态
DEFAULT_PROGRESS_RUNNING = 30
DEFAULT_PROGRESS_COMPLETE = 100

# 默认值
DEFAULT_TASK_ID = -1