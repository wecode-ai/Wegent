# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import enum

class TaskStatus(str, enum.Enum):
    RUNNING = "RUNNING"  # Task is running
    FAILED = "FAILED"  # Task execution failed
    SUCCESS = "SUCCESS"  # Task executed successfully, subtask completed
    PENDING = "PENDING"  # Waiting for execution
    COMPLETED = "COMPLETED"  # Task completed
    
    # New status
    INITIALIZED = "INITIALIZED"  # Initialization completed
    PRE_EXECUTED = "PRE_EXECUTED"  # Pre-execution completed
    CANCELLED = "CANCELLED"  # Task cancelled
    TIMEOUT = "TIMEOUT"  # Task execution timeout