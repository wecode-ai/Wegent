# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import pytest

from chat_shell.api.v1.schemas import Metadata, ResponseRequest
from shared.models.execution import ExecutionRequest


class TestMetadata:
    """Tests for Metadata schema."""

    def test_metadata_with_execution_request(self) -> None:
        """Test that Metadata accepts ExecutionRequest for task_data."""
        execution_request = ExecutionRequest(
            task_id=123,
            subtask_id=456,
            user_name="test_user",
        )

        metadata = Metadata(
            task_id=123,
            task_data=execution_request,
        )

        assert metadata.task_data is not None
        assert metadata.task_data.task_id == 123
        assert metadata.task_data.subtask_id == 456
        assert metadata.task_data.user_name == "test_user"

    def test_metadata_with_none_task_data(self) -> None:
        """Test that Metadata accepts None for task_data."""
        metadata = Metadata(
            task_id=123,
            task_data=None,
        )

        assert metadata.task_data is None
