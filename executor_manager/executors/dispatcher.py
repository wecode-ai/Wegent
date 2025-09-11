# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from typing import Dict
from .docker import DockerExecutor

# from executor_manager.executors.local_executor import LocalExecutor  # Can be extended later


class ExecutorDispatcher:
    """
    Dynamically select the appropriate Executor instance based on the task type.
    """

    _executors = {"docker": DockerExecutor()}

    @classmethod
    def get_executor(cls, task_type: str):
        """
        Return the corresponding Executor instance according to the task type.
        Supports 'docker', and can be extended to 'local' and others in the future.
        """
        if "docker" not in cls._executors:
            cls._executors["docker"]
        return cls._executors["docker"]
