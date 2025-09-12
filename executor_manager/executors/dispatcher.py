# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from typing import Dict

from executor_manager.wecode.executors.k8s.k8s_executor import K8sExecutor
from .docker import DockerExecutor
from shared.logger import setup_logger

logger = setup_logger(__name__)

# from executor_manager.executors.local_executor import LocalExecutor  # Can be extended later


class ExecutorDispatcher:
    """
    Dynamically select the appropriate Executor instance based on the task type.
    """

    _executors = {"docker": DockerExecutor(), "k8s": K8sExecutor()}

    @classmethod
    def get_executor(cls, task_type: str):
        """
        Return the corresponding Executor instance according to the task type.
        Supports 'docker', and can be extended to 'local' and others in the future.
        """
        logger.info(f"Fetching executor for task type: {task_type}")
        if task_type not in cls._executors:
            return cls._executors["docker"]
        return cls._executors[task_type]
