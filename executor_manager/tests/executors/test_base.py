# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import pytest

from executor_manager.executors.base import Executor


class TestExecutor:
    """Test cases for the Executor base class"""

    def test_executor_is_abstract(self):
        """Test that Executor cannot be instantiated directly"""
        with pytest.raises(TypeError):
            Executor()

    def test_submit_executor_is_abstract(self):
        """Test that submit_executor is an abstract method"""

        class IncompleteExecutor(Executor):
            def get_current_task_ids(self, label_selector=None):
                pass

            def delete_executor(self, pod_name):
                pass

            def get_executor_count(self, label_selector=None):
                pass

            def get_container_status(self, executor_name):
                pass

        with pytest.raises(TypeError):
            IncompleteExecutor()

    def test_get_current_task_ids_is_abstract(self):
        """Test that get_current_task_ids is an abstract method"""

        class IncompleteExecutor(Executor):
            def submit_executor(self, task, callback=None):
                pass

            def delete_executor(self, pod_name):
                pass

            def get_executor_count(self, label_selector=None):
                pass

            def get_container_status(self, executor_name):
                pass

        with pytest.raises(TypeError):
            IncompleteExecutor()

    def test_delete_executor_is_abstract(self):
        """Test that delete_executor is an abstract method"""

        class IncompleteExecutor(Executor):
            def submit_executor(self, task, callback=None):
                pass

            def get_current_task_ids(self, label_selector=None):
                pass

            def get_executor_count(self, label_selector=None):
                pass

            def get_container_status(self, executor_name):
                pass

        with pytest.raises(TypeError):
            IncompleteExecutor()

    def test_get_executor_count_is_abstract(self):
        """Test that get_executor_count is an abstract method"""

        class IncompleteExecutor(Executor):
            def submit_executor(self, task, callback=None):
                pass

            def get_current_task_ids(self, label_selector=None):
                pass

            def delete_executor(self, pod_name):
                pass

            def get_container_status(self, executor_name):
                pass

        with pytest.raises(TypeError):
            IncompleteExecutor()

    def test_get_container_status_is_abstract(self):
        """Test that get_container_status is an abstract method"""

        class IncompleteExecutor(Executor):
            def submit_executor(self, task, callback=None):
                pass

            def get_current_task_ids(self, label_selector=None):
                pass

            def delete_executor(self, pod_name):
                pass

            def get_executor_count(self, label_selector=None):
                pass

        with pytest.raises(TypeError):
            IncompleteExecutor()

    def test_complete_executor_implementation(self):
        """Test that a complete implementation can be instantiated"""

        class CompleteExecutor(Executor):
            def submit_executor(self, task, callback=None):
                return {"status": "success"}

            def get_current_task_ids(self, label_selector=None):
                return {"task_ids": []}

            def delete_executor(self, pod_name):
                return {"status": "success"}

            def get_executor_count(self, label_selector=None):
                return {"count": 0}

            def get_container_status(self, executor_name):
                return {
                    "exists": True,
                    "status": "running",
                    "oom_killed": False,
                    "exit_code": 0,
                    "error_msg": None,
                }

        executor = CompleteExecutor()
        assert isinstance(executor, Executor)
        assert executor.submit_executor({}) == {"status": "success"}
        assert executor.get_current_task_ids() == {"task_ids": []}
        assert executor.delete_executor("test") == {"status": "success"}
        assert executor.get_executor_count() == {"count": 0}
        assert executor.get_container_status("test")["exists"] is True
