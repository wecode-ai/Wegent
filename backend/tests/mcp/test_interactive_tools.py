# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Tests for MCP interactive tools.
"""

import pytest
from unittest.mock import AsyncMock, MagicMock, patch

from app.mcp.context import (
    TaskContext,
    TaskContextManager,
    get_task_context,
    set_task_context,
    clear_task_context,
    get_task_id,
)
from app.mcp.schemas.message import Attachment, SendMessageInput, SendMessageResult
from app.mcp.schemas.form import (
    FormField,
    FieldOption,
    FieldValidation,
    SendFormInput,
    SendFormResult,
    SendConfirmInput,
    SendConfirmResult,
    SendSelectInput,
    SelectOption,
    SendSelectResult,
)


class TestTaskContext:
    """Tests for task context management."""

    def test_get_task_context_when_not_set(self):
        """Test that get_task_context returns None when not set."""
        clear_task_context()
        assert get_task_context() is None

    def test_set_and_get_task_context(self):
        """Test setting and getting task context."""
        ctx = TaskContext(task_id=123, subtask_id=456, user_id=789)
        set_task_context(ctx)

        result = get_task_context()
        assert result is not None
        assert result.task_id == 123
        assert result.subtask_id == 456
        assert result.user_id == 789

        clear_task_context()

    def test_clear_task_context(self):
        """Test clearing task context."""
        ctx = TaskContext(task_id=123)
        set_task_context(ctx)
        assert get_task_context() is not None

        clear_task_context()
        assert get_task_context() is None

    def test_get_task_id_convenience(self):
        """Test get_task_id convenience function."""
        clear_task_context()
        assert get_task_id() is None

        ctx = TaskContext(task_id=999)
        set_task_context(ctx)
        assert get_task_id() == 999

        clear_task_context()

    def test_task_context_manager(self):
        """Test TaskContextManager as context manager."""
        clear_task_context()
        assert get_task_context() is None

        with TaskContextManager(task_id=100, subtask_id=200) as ctx:
            assert ctx.task_id == 100
            assert ctx.subtask_id == 200
            assert get_task_id() == 100

        # Context should be cleared after exiting
        assert get_task_context() is None


class TestSchemas:
    """Tests for MCP schemas."""

    def test_attachment_schema(self):
        """Test Attachment schema."""
        attachment = Attachment(
            name="test.pdf",
            url="https://example.com/test.pdf",
            mime_type="application/pdf",
            size=1024,
        )
        assert attachment.name == "test.pdf"
        assert attachment.url == "https://example.com/test.pdf"
        assert attachment.mime_type == "application/pdf"
        assert attachment.size == 1024

    def test_attachment_schema_without_size(self):
        """Test Attachment schema without optional size."""
        attachment = Attachment(
            name="image.png",
            url="https://example.com/image.png",
            mime_type="image/png",
        )
        assert attachment.name == "image.png"
        assert attachment.size is None

    def test_send_message_input_schema(self):
        """Test SendMessageInput schema."""
        input_data = SendMessageInput(
            content="Hello, world!",
            message_type="markdown",
            attachments=[
                Attachment(
                    name="file.txt",
                    url="https://example.com/file.txt",
                    mime_type="text/plain",
                )
            ],
        )
        assert input_data.content == "Hello, world!"
        assert input_data.message_type == "markdown"
        assert len(input_data.attachments) == 1

    def test_send_message_result_schema(self):
        """Test SendMessageResult schema."""
        result = SendMessageResult(
            success=True,
            message_id="msg_abc123",
        )
        assert result.success is True
        assert result.message_id == "msg_abc123"
        assert result.error is None

    def test_form_field_schema(self):
        """Test FormField schema."""
        field = FormField(
            field_id="username",
            field_type="text",
            label="Username",
            placeholder="Enter your username",
            validation=FieldValidation(required=True, min_length=3, max_length=20),
            options=None,
        )
        assert field.field_id == "username"
        assert field.field_type == "text"
        assert field.validation.required is True
        assert field.validation.min_length == 3

    def test_form_field_with_options(self):
        """Test FormField with options for choice fields."""
        field = FormField(
            field_id="color",
            field_type="single_choice",
            label="Favorite Color",
            options=[
                FieldOption(value="red", label="Red", recommended=False),
                FieldOption(value="blue", label="Blue", recommended=True),
                FieldOption(value="green", label="Green", recommended=False),
            ],
        )
        assert field.field_type == "single_choice"
        assert len(field.options) == 3
        assert field.options[1].recommended is True

    def test_send_form_input_schema(self):
        """Test SendFormInput schema."""
        form_input = SendFormInput(
            title="User Registration",
            description="Please fill out the form",
            fields=[
                FormField(
                    field_id="name",
                    field_type="text",
                    label="Name",
                )
            ],
            submit_button_text="Register",
        )
        assert form_input.title == "User Registration"
        assert form_input.submit_button_text == "Register"
        assert len(form_input.fields) == 1

    def test_send_confirm_input_schema(self):
        """Test SendConfirmInput schema."""
        confirm_input = SendConfirmInput(
            title="Confirm Action",
            message="Are you sure you want to proceed?",
            confirm_text="Yes, proceed",
            cancel_text="No, cancel",
        )
        assert confirm_input.title == "Confirm Action"
        assert confirm_input.confirm_text == "Yes, proceed"
        assert confirm_input.cancel_text == "No, cancel"

    def test_send_select_input_schema(self):
        """Test SendSelectInput schema."""
        select_input = SendSelectInput(
            title="Select Options",
            options=[
                SelectOption(value="opt1", label="Option 1", recommended=True),
                SelectOption(value="opt2", label="Option 2", description="Description"),
            ],
            multiple=True,
            description="Select one or more options",
        )
        assert select_input.title == "Select Options"
        assert select_input.multiple is True
        assert len(select_input.options) == 2
        assert select_input.options[0].recommended is True


class TestSendMessageTool:
    """Tests for send_message MCP tool."""

    @pytest.mark.asyncio
    async def test_send_message_without_context(self):
        """Test send_message fails without task context."""
        from app.mcp.tools.send_message import send_message

        clear_task_context()
        result = await send_message(content="Hello")

        assert result.success is False
        assert "No task context" in result.error

    @pytest.mark.asyncio
    async def test_send_message_with_context(self):
        """Test send_message succeeds with task context."""
        from app.mcp.tools.send_message import send_message

        # Mock the WebSocket emitter
        mock_emitter = AsyncMock()
        mock_emitter.emit_interactive_message = AsyncMock()

        with patch("app.services.chat.ws_emitter.get_ws_emitter", return_value=mock_emitter):
            with TaskContextManager(task_id=123):
                result = await send_message(
                    content="Hello, world!",
                    message_type="markdown",
                )

        assert result.success is True
        assert result.message_id.startswith("msg_")
        mock_emitter.emit_interactive_message.assert_called_once()


class TestSendFormTool:
    """Tests for send_form MCP tool."""

    @pytest.mark.asyncio
    async def test_send_form_without_context(self):
        """Test send_form fails without task context."""
        from app.mcp.tools.send_form import send_form

        clear_task_context()
        result = await send_form(
            title="Test Form",
            fields=[
                FormField(field_id="test", field_type="text", label="Test"),
            ],
        )

        assert result.success is False
        assert "No task context" in result.error

    @pytest.mark.asyncio
    async def test_send_form_with_context(self):
        """Test send_form succeeds with task context."""
        from app.mcp.tools.send_form import send_form

        mock_emitter = AsyncMock()
        mock_emitter.emit_interactive_message = AsyncMock()

        with patch("app.services.chat.ws_emitter.get_ws_emitter", return_value=mock_emitter):
            with TaskContextManager(task_id=456):
                result = await send_form(
                    title="User Survey",
                    fields=[
                        FormField(
                            field_id="rating",
                            field_type="single_choice",
                            label="Rating",
                            options=[
                                FieldOption(value="1", label="Poor"),
                                FieldOption(value="5", label="Excellent"),
                            ],
                        ),
                    ],
                    submit_button_text="Submit Survey",
                )

        assert result.success is True
        assert result.form_id.startswith("form_")


class TestSendConfirmTool:
    """Tests for send_confirm MCP tool."""

    @pytest.mark.asyncio
    async def test_send_confirm_without_context(self):
        """Test send_confirm fails without task context."""
        from app.mcp.tools.send_confirm import send_confirm

        clear_task_context()
        result = await send_confirm(
            title="Confirm",
            message="Are you sure?",
        )

        assert result.success is False
        assert "No task context" in result.error

    @pytest.mark.asyncio
    async def test_send_confirm_with_context(self):
        """Test send_confirm succeeds with task context."""
        from app.mcp.tools.send_confirm import send_confirm

        mock_emitter = AsyncMock()
        mock_emitter.emit_interactive_message = AsyncMock()

        with patch("app.services.chat.ws_emitter.get_ws_emitter", return_value=mock_emitter):
            with TaskContextManager(task_id=789):
                result = await send_confirm(
                    title="Delete Confirmation",
                    message="This action cannot be undone.",
                    confirm_text="Delete",
                    cancel_text="Keep",
                )

        assert result.success is True
        assert result.confirm_id.startswith("confirm_")


class TestSendSelectTool:
    """Tests for send_select MCP tool."""

    @pytest.mark.asyncio
    async def test_send_select_without_context(self):
        """Test send_select fails without task context."""
        from app.mcp.tools.send_select import send_select

        clear_task_context()
        result = await send_select(
            title="Select",
            options=[SelectOption(value="a", label="A")],
        )

        assert result.success is False
        assert "No task context" in result.error

    @pytest.mark.asyncio
    async def test_send_select_with_context(self):
        """Test send_select succeeds with task context."""
        from app.mcp.tools.send_select import send_select

        mock_emitter = AsyncMock()
        mock_emitter.emit_interactive_message = AsyncMock()

        with patch("app.services.chat.ws_emitter.get_ws_emitter", return_value=mock_emitter):
            with TaskContextManager(task_id=999):
                result = await send_select(
                    title="Choose Database",
                    options=[
                        SelectOption(value="mysql", label="MySQL", recommended=True),
                        SelectOption(value="postgres", label="PostgreSQL"),
                    ],
                    multiple=False,
                    description="Select your preferred database",
                )

        assert result.success is True
        assert result.select_id.startswith("select_")
