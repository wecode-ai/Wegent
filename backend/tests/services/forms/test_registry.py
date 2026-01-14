# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for form handler registry."""

import pytest

from app.services.forms.base_handler import BaseFormHandler, FormContext, FormHandlerResult
from app.services.forms.registry import (
    form_handler,
    get_handler,
    get_registered_action_types,
    is_action_type_registered,
    _form_handlers,
)


class TestFormHandlerRegistry:
    """Tests for the form handler registry."""

    def setup_method(self):
        """Store original handlers before each test."""
        self._original_handlers = _form_handlers.copy()

    def teardown_method(self):
        """Restore original handlers after each test."""
        _form_handlers.clear()
        _form_handlers.update(self._original_handlers)

    def test_form_handler_decorator_registers_handler(self):
        """Test that @form_handler decorator registers the handler."""
        @form_handler("test_action")
        class TestHandler(BaseFormHandler):
            async def validate(self, form_data, context):
                return FormHandlerResult.ok()

            async def process(self, form_data, context):
                return FormHandlerResult.ok()

        assert is_action_type_registered("test_action")
        assert get_handler("test_action") == TestHandler

    def test_get_handler_raises_for_unknown_type(self):
        """Test that get_handler raises ValueError for unknown action type."""
        with pytest.raises(ValueError) as exc_info:
            get_handler("nonexistent_action")

        assert "Unknown action_type" in str(exc_info.value)
        assert "nonexistent_action" in str(exc_info.value)

    def test_get_registered_action_types(self):
        """Test get_registered_action_types returns list of registered types."""
        @form_handler("type_a")
        class HandlerA(BaseFormHandler):
            async def validate(self, form_data, context):
                return FormHandlerResult.ok()

            async def process(self, form_data, context):
                return FormHandlerResult.ok()

        @form_handler("type_b")
        class HandlerB(BaseFormHandler):
            async def validate(self, form_data, context):
                return FormHandlerResult.ok()

            async def process(self, form_data, context):
                return FormHandlerResult.ok()

        types = get_registered_action_types()
        assert "type_a" in types
        assert "type_b" in types

    def test_is_action_type_registered(self):
        """Test is_action_type_registered returns correct boolean."""
        @form_handler("registered_type")
        class RegisteredHandler(BaseFormHandler):
            async def validate(self, form_data, context):
                return FormHandlerResult.ok()

            async def process(self, form_data, context):
                return FormHandlerResult.ok()

        assert is_action_type_registered("registered_type") is True
        assert is_action_type_registered("unregistered_type") is False


class TestFormHandlerResult:
    """Tests for FormHandlerResult dataclass."""

    def test_ok_creates_success_result(self):
        """Test FormHandlerResult.ok creates successful result."""
        result = FormHandlerResult.ok("Success message", {"key": "value"})

        assert result.success is True
        assert result.message == "Success message"
        assert result.data == {"key": "value"}
        assert result.error_code is None

    def test_error_creates_failure_result(self):
        """Test FormHandlerResult.error creates failure result."""
        result = FormHandlerResult.error("Error message", error_code="ERR_001")

        assert result.success is False
        assert result.message == "Error message"
        assert result.error_code == "ERR_001"


class TestFormContext:
    """Tests for FormContext dataclass."""

    def test_from_dict_with_all_fields(self):
        """Test FormContext.from_dict creates context from dict."""
        data = {
            "task_id": 123,
            "subtask_id": 456,
            "message_id": 789,
            "team_id": 10,
            "extra": {"custom": "value"},
        }

        context = FormContext.from_dict(data)

        assert context.task_id == 123
        assert context.subtask_id == 456
        assert context.message_id == 789
        assert context.team_id == 10
        assert context.extra == {"custom": "value"}

    def test_from_dict_with_none(self):
        """Test FormContext.from_dict handles None input."""
        context = FormContext.from_dict(None)

        assert context.task_id is None
        assert context.subtask_id is None
        assert context.message_id is None
        assert context.team_id is None
        assert context.extra == {}

    def test_from_dict_with_partial_data(self):
        """Test FormContext.from_dict handles partial data."""
        data = {"task_id": 123}

        context = FormContext.from_dict(data)

        assert context.task_id == 123
        assert context.subtask_id is None
        assert context.team_id is None
