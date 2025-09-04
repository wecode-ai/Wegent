# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import abc
from typing import Any, Dict, Optional


class Executor(abc.ABC):

    @abc.abstractmethod
    def submit_executor(
        self, task: Dict[str, Any], callback: Optional[callable] = None
    ) -> Dict[str, Any]:
        pass

    @abc.abstractmethod
    def get_current_task_ids(
        self, label_selector: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        Get the IDs of all tasks currently being executed.
        
        Args:
            label_selector: Optional selector to filter tasks
            
        Returns:
            Dict containing a list of current task IDs and related information
        """
        pass

    @abc.abstractmethod
    def delete_executor(self, job_name: str) -> Dict[str, Any]:
        pass

    @abc.abstractmethod
    def get_executor_count(
        self, label_selector: Optional[str] = None
    ) -> Dict[str, Any]:
        pass
