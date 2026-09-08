# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Unit tests for TelegramChannelHandler."""

from datetime import datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import HTTPException

from app.models.subtask import SubtaskStatus
from app.services.channels.callback import ChannelType
from app.services.channels.device_selection import DeviceSelection, DeviceType
from app.services.channels.handler import MessageContext
from app.services.channels.telegram.handler import TelegramChannelHandler
from app.services.execution.emitters import (
    CompositeResultEmitter,
    WebSocketResultEmitter,
)

EXPECTED_IM_SOURCE = {
    "source": "im",
    "channel_type": "telegram",
    "channel_label": "Telegram",
}


def _message_context() -> MessageContext:
    return MessageContext(
        content="Hello from Telegram",
        sender_id="12345",
        sender_name="Test",
        conversation_id="67890",
        conversation_type="private",
        is_mention=False,
        raw_message=MagicMock(),
        extra_data={},
    )


def _creation_result() -> SimpleNamespace:
    return SimpleNamespace(
        task=SimpleNamespace(id=200),
        user_subtask=SimpleNamespace(id=300),
        assistant_subtask=SimpleNamespace(id=301),
    )


def _streaming_emitter() -> SimpleNamespace:
    return SimpleNamespace(
        emit_start=AsyncMock(),
        emit_chunk=AsyncMock(),
        set_shared_content_key=MagicMock(),
    )


def _assert_message_source(create_task_mock: AsyncMock) -> None:
    params = create_task_mock.await_args.kwargs["params"]
    assert params.message_source == EXPECTED_IM_SOURCE


class TestTelegramChannelHandler:
    """Tests for TelegramChannelHandler."""

    @pytest.fixture
    def mock_bot(self):
        """Create a mock Telegram Bot."""
        bot = MagicMock()
        bot.send_message = AsyncMock()
        return bot

    @pytest.fixture
    def handler(self, mock_bot):
        """Create TelegramChannelHandler instance."""
        return TelegramChannelHandler(
            channel_id=1,
            bot=mock_bot,
            use_inline_keyboard=True,
            get_default_team_id=lambda: 100,
            get_default_model_name=lambda: "test-model",
            get_user_mapping_config=lambda: {
                "mode": "select_user",
                "config": {"target_user_id": 1},
            },
        )

    def test_init(self, handler, mock_bot):
        """Test handler initialization."""
        assert handler._channel_id == 1
        assert handler._bot == mock_bot
        assert handler._use_inline_keyboard is True
        assert handler.channel_type == ChannelType.TELEGRAM

    def test_set_bot(self, handler):
        """Test setting bot after initialization."""
        new_bot = MagicMock()
        handler.set_bot(new_bot)
        assert handler._bot == new_bot

    def test_default_team_id(self, handler):
        """Test getting default team ID."""
        assert handler.default_team_id == 100

    def test_default_model_name(self, handler):
        """Test getting default model name."""
        assert handler.default_model_name == "test-model"

    def test_user_mapping_config(self, handler):
        """Test getting user mapping config."""
        config = handler.user_mapping_config
        assert config.mode == "select_user"
        assert config.config == {"target_user_id": 1}

    def test_parse_message_regular(self, handler):
        """Test parsing regular text message."""
        # Create mock Update with message
        mock_user = MagicMock()
        mock_user.id = 12345
        mock_user.username = "testuser"
        mock_user.first_name = "Test"
        mock_user.last_name = "User"

        mock_chat = MagicMock()
        mock_chat.id = 67890
        mock_chat.type = "private"

        mock_message = MagicMock()
        mock_message.from_user = mock_user
        mock_message.chat = mock_chat
        mock_message.chat_id = 67890
        mock_message.message_id = 111
        mock_message.text = "Hello, bot!"
        mock_message.entities = None

        mock_update = MagicMock()
        mock_update.callback_query = None
        mock_update.message = mock_message
        mock_update.edited_message = None

        context = handler.parse_message(mock_update)

        assert context.content == "Hello, bot!"
        assert context.sender_id == "12345"
        assert context.sender_name == "Test"
        assert context.conversation_id == "67890"
        assert context.conversation_type == "private"
        assert context.is_mention is False
        assert context.extra_data["telegram_user_id"] == 12345
        assert context.extra_data["telegram_username"] == "testuser"
        assert context.extra_data["is_callback_query"] is False

    def test_parse_message_callback_query(self, handler):
        """Test parsing callback query."""
        mock_user = MagicMock()
        mock_user.id = 12345
        mock_user.username = "testuser"
        mock_user.first_name = "Test"

        mock_message = MagicMock()
        mock_message.chat_id = 67890
        mock_message.message_id = 111
        mock_message.chat = MagicMock()
        mock_message.chat.type = "private"

        mock_query = MagicMock()
        mock_query.id = "query123"
        mock_query.from_user = mock_user
        mock_query.data = "model:3"
        mock_query.message = mock_message

        mock_update = MagicMock()
        mock_update.callback_query = mock_query
        mock_update.message = None
        mock_update.edited_message = None

        context = handler.parse_message(mock_update)

        assert context.content == "model:3"
        assert context.sender_id == "12345"
        assert context.extra_data["is_callback_query"] is True
        assert context.extra_data["callback_query_id"] == "query123"

    def test_parse_message_group_mention(self, handler):
        """Test parsing message with bot mention in group."""
        mock_user = MagicMock()
        mock_user.id = 12345
        mock_user.username = "testuser"
        mock_user.first_name = "Test"

        mock_chat = MagicMock()
        mock_chat.id = 67890
        mock_chat.type = "group"

        mock_entity = MagicMock()
        mock_entity.type = "mention"

        mock_message = MagicMock()
        mock_message.from_user = mock_user
        mock_message.chat = mock_chat
        mock_message.chat_id = 67890
        mock_message.message_id = 111
        mock_message.text = "@bot Hello!"
        mock_message.entities = [mock_entity]

        mock_update = MagicMock()
        mock_update.callback_query = None
        mock_update.message = mock_message
        mock_update.edited_message = None

        context = handler.parse_message(mock_update)

        assert context.is_mention is True
        assert context.conversation_type == "group"

    def test_parse_message_empty_update(self, handler):
        """Test parsing update without message."""
        mock_update = MagicMock()
        mock_update.callback_query = None
        mock_update.message = None
        mock_update.edited_message = None

        context = handler.parse_message(mock_update)

        assert context.content == ""
        assert context.sender_id == ""

    @pytest.mark.asyncio
    async def test_send_text_reply(self, handler, mock_bot):
        """Test sending text reply."""
        mock_context = MagicMock()
        mock_context.conversation_id = "67890"

        result = await handler.send_text_reply(mock_context, "Hello!")

        assert result is True
        mock_bot.send_message.assert_called_once_with(
            chat_id=67890,
            text="Hello!",
        )

    @pytest.mark.asyncio
    async def test_send_text_reply_no_bot(self, handler):
        """Test sending reply without bot instance."""
        handler._bot = None
        mock_context = MagicMock()
        mock_context.conversation_id = "67890"

        result = await handler.send_text_reply(mock_context, "Hello!")

        assert result is False

    @pytest.mark.asyncio
    async def test_send_text_reply_no_chat_id(self, handler, mock_bot):
        """Test sending reply without chat ID."""
        mock_context = MagicMock()
        mock_context.conversation_id = ""
        handler._current_chat_id = None

        result = await handler.send_text_reply(mock_context, "Hello!")

        assert result is False

    @pytest.mark.asyncio
    async def test_send_text_reply_error(self, handler, mock_bot):
        """Test sending reply with API error."""
        mock_bot.send_message.side_effect = Exception("API Error")
        mock_context = MagicMock()
        mock_context.conversation_id = "67890"

        result = await handler.send_text_reply(mock_context, "Hello!")

        assert result is False

    def test_create_callback_info(self, handler):
        """Test creating callback info."""
        mock_context = MagicMock()
        mock_context.conversation_id = "67890"

        info = handler.create_callback_info(mock_context)

        assert info.channel_id == 1
        assert info.conversation_id == "67890"
        assert info.chat_id == 67890

    def test_get_callback_service(self, handler):
        """Test getting callback service."""
        from app.services.channels.telegram.callback import telegram_callback_service

        service = handler.get_callback_service()

        assert service == telegram_callback_service

    @pytest.mark.asyncio
    async def test_device_callback_selects_app_execution_target(self, handler):
        user = SimpleNamespace(id=6)
        devices = [
            {
                "device_id": "local-device",
                "execution_target_id": "app-record-1819",
                "name": "APB22015038",
                "status": "online",
            }
        ]

        with (
            patch("app.services.channels.telegram.handler.SessionLocal"),
            patch(
                "app.services.device_service.device_service.get_all_devices",
                new=AsyncMock(return_value=devices),
            ),
            patch(
                "app.services.channels.device_selection.device_selection_manager.set_local_device",
                new=AsyncMock(return_value=True),
            ) as set_local_device,
        ):
            result = await handler._handle_device_callback(user, "1")

        assert result == "✅ 已切换到设备 **APB22015038**"
        set_local_device.assert_awaited_once_with(
            user.id,
            "app-record-1819",
            "APB22015038",
        )

    @pytest.mark.asyncio
    async def test_device_mode_callback_migrates_legacy_app_selection(self, handler):
        user = SimpleNamespace(id=6)
        selection = DeviceSelection(
            device_type=DeviceType.LOCAL,
            device_id="local-device",
            device_name="APB22015038",
        )
        route = SimpleNamespace(
            logical_device_id="local-device",
            runtime_device_id="app-record-1819",
        )

        with (
            patch(
                "app.services.channels.device_selection.device_selection_manager.get_selection",
                new=AsyncMock(return_value=selection),
            ),
            patch(
                "app.services.channels.device_selection.device_selection_manager.set_local_device",
                new=AsyncMock(return_value=True),
            ) as set_local_device,
            patch(
                "app.services.device.runtime_route.runtime_route_resolver.resolve",
                new=AsyncMock(return_value=route),
            ),
        ):
            result = await handler._handle_mode_callback(user, "device")

        assert result == "✅ 已切换到**设备模式**"
        set_local_device.assert_awaited_once_with(
            user.id,
            "app-record-1819",
            "APB22015038",
        )

    @pytest.mark.asyncio
    async def test_create_streaming_emitter(self, handler, mock_bot):
        """Test creating streaming emitter."""
        mock_context = MagicMock()
        mock_context.conversation_id = "67890"

        emitter = await handler.create_streaming_emitter(mock_context)

        assert emitter is not None
        assert emitter._chat_id == 67890

    @pytest.mark.asyncio
    async def test_create_streaming_emitter_no_bot(self, handler):
        """Test creating streaming emitter without bot."""
        handler._bot = None
        mock_context = MagicMock()
        mock_context.conversation_id = "67890"

        emitter = await handler.create_streaming_emitter(mock_context)

        assert emitter is None

    @pytest.mark.asyncio
    async def test_create_and_process_chat_attaches_im_source_metadata(self, handler):
        """Chat task creation should tag tasks with provider-level IM metadata."""
        message_context = _message_context()
        user = SimpleNamespace(id=1)
        team = SimpleNamespace(id=100)
        creation_result = _creation_result()
        db = MagicMock()
        streaming_emitter = _streaming_emitter()
        event_order: list[str] = []
        streaming_emitter.emit_start.side_effect = lambda **_: event_order.append(
            "assistant_start"
        )

        with (
            patch(
                "app.services.channels.handler.SessionLocal",
                return_value=db,
            ),
            patch.object(
                handler,
                "_get_user_model_override",
                new=AsyncMock(return_value=(None, None)),
            ),
            patch.object(
                handler,
                "_get_conversation_task_id",
                new=AsyncMock(return_value=(None, False)),
            ),
            patch.object(
                handler,
                "_set_conversation_task_id",
                new=AsyncMock(),
            ),
            patch.object(
                handler,
                "_get_selected_or_default_team",
                new=AsyncMock(return_value=team),
            ),
            patch.object(
                handler,
                "create_streaming_emitter",
                new=AsyncMock(return_value=streaming_emitter),
            ),
            patch.object(
                handler,
                "_register_streaming_emitter",
                new=AsyncMock(),
            ),
            patch.object(
                handler,
                "_broadcast_user_message_to_web",
                new=AsyncMock(
                    side_effect=lambda **_: event_order.append("user_message")
                ),
            ) as broadcast_mock,
            patch(
                "app.services.chat.storage.task_manager.create_task_and_subtasks",
                new=AsyncMock(return_value=creation_result),
            ) as create_task_mock,
            patch(
                "app.services.chat.trigger.trigger_ai_response_unified",
                new=AsyncMock(),
            ) as trigger_mock,
        ):
            result = await handler._create_and_process_chat(user, message_context)

        assert result is None
        broadcast_mock.assert_awaited_once_with(
            db=db,
            task_id=creation_result.task.id,
            user_subtask=creation_result.user_subtask,
            message=message_context.content,
            user=user,
        )
        assert event_order[:2] == ["user_message", "assistant_start"]
        dispatch_emitter = trigger_mock.await_args.kwargs["result_emitter"]
        assert isinstance(dispatch_emitter, CompositeResultEmitter)
        assert dispatch_emitter.emitters[0] is streaming_emitter
        websocket_emitter = dispatch_emitter.emitters[1]
        assert isinstance(websocket_emitter, WebSocketResultEmitter)
        assert websocket_emitter.task_id == creation_result.task.id
        assert websocket_emitter.subtask_id == creation_result.assistant_subtask.id
        assert websocket_emitter.user_id == user.id
        _assert_message_source(create_task_mock)

    @pytest.mark.asyncio
    async def test_create_and_process_chat_keeps_device_streaming_emitter_open(
        self, handler
    ):
        message_context = _message_context()
        user = SimpleNamespace(id=1)
        team = SimpleNamespace(id=100)
        creation_result = _creation_result()
        creation_result.task.json = {"spec": {"device_id": "hw-4e4bfa88fa25"}}
        db = MagicMock()
        streaming_emitter = _streaming_emitter()

        with (
            patch(
                "app.services.channels.handler.SessionLocal",
                return_value=db,
            ),
            patch.object(
                handler,
                "_get_user_model_override",
                new=AsyncMock(return_value=(None, None)),
            ),
            patch.object(
                handler,
                "_get_conversation_task_id",
                new=AsyncMock(return_value=(61, False)),
            ),
            patch.object(
                handler,
                "_set_conversation_task_id",
                new=AsyncMock(),
            ),
            patch.object(
                handler,
                "_get_selected_or_default_team",
                new=AsyncMock(return_value=team),
            ),
            patch.object(
                handler,
                "create_streaming_emitter",
                new=AsyncMock(return_value=streaming_emitter),
            ),
            patch.object(
                handler,
                "_register_streaming_emitter",
                new=AsyncMock(),
            ),
            patch.object(
                handler,
                "_broadcast_user_message_to_web",
                new=AsyncMock(),
            ),
            patch(
                "app.services.chat.storage.task_manager.create_task_and_subtasks",
                new=AsyncMock(return_value=creation_result),
            ),
            patch(
                "app.services.chat.trigger.trigger_ai_response_unified",
                new=AsyncMock(),
            ) as trigger_mock,
        ):
            result = await handler._create_and_process_chat(user, message_context)

        assert result is None
        assert trigger_mock.await_args.kwargs["result_emitter"] is None

    @pytest.mark.asyncio
    async def test_create_and_process_device_task_attaches_im_source_metadata(
        self, handler
    ):
        """Device task creation should tag tasks with provider-level IM metadata."""
        message_context = _message_context()
        user = SimpleNamespace(id=1)
        team = SimpleNamespace(id=100)
        creation_result = _creation_result()
        db = MagicMock()
        streaming_emitter = _streaming_emitter()
        event_order: list[str] = []
        streaming_emitter.emit_start.side_effect = lambda **_: event_order.append(
            "assistant_start"
        )

        with (
            patch.object(
                handler,
                "_get_device_mode_model_override",
                new=AsyncMock(return_value=(None, None)),
            ),
            patch.object(
                handler,
                "_get_conversation_task_id",
                new=AsyncMock(return_value=(None, False)),
            ),
            patch.object(
                handler,
                "_set_conversation_task_id",
                new=AsyncMock(),
            ),
            patch.object(
                handler,
                "create_streaming_emitter",
                new=AsyncMock(return_value=streaming_emitter),
            ),
            patch.object(
                handler,
                "_register_streaming_emitter",
                new=AsyncMock(),
            ),
            patch.object(
                handler,
                "_broadcast_user_message_to_web",
                new=AsyncMock(
                    side_effect=lambda **_: event_order.append("user_message")
                ),
            ) as broadcast_mock,
            patch(
                "app.services.chat.storage.task_manager.create_task_and_subtasks",
                new=AsyncMock(return_value=creation_result),
            ) as create_task_mock,
            patch(
                "app.services.device_router.route_task_to_device",
                new=AsyncMock(),
            ),
        ):
            result = await handler._create_and_process_device_task(
                db=db,
                user=user,
                team=team,
                device_id="device-123456",
                message_context=message_context,
            )

        assert result is None
        broadcast_mock.assert_awaited_once_with(
            db=db,
            task_id=creation_result.task.id,
            user_subtask=creation_result.user_subtask,
            message=message_context.content,
            user=user,
        )
        assert event_order[:2] == ["user_message", "assistant_start"]
        _assert_message_source(create_task_mock)

    @pytest.mark.asyncio
    async def test_create_and_process_cloud_task_attaches_im_source_metadata(
        self, handler
    ):
        """Cloud task creation should tag tasks with provider-level IM metadata."""
        message_context = _message_context()
        user = SimpleNamespace(id=1)
        team = SimpleNamespace(id=100)
        creation_result = _creation_result()
        db = MagicMock()
        streaming_emitter = _streaming_emitter()
        event_order: list[str] = []

        with (
            patch.object(
                handler,
                "_get_user_model_override",
                new=AsyncMock(return_value=(None, None)),
            ),
            patch.object(
                handler,
                "_get_conversation_task_id",
                new=AsyncMock(return_value=(None, False)),
            ),
            patch.object(
                handler,
                "_set_conversation_task_id",
                new=AsyncMock(),
            ),
            patch.object(
                handler,
                "create_streaming_emitter",
                new=AsyncMock(return_value=streaming_emitter),
            ),
            patch.object(
                handler,
                "_register_streaming_emitter",
                new=AsyncMock(),
            ),
            patch.object(
                handler,
                "_broadcast_user_message_to_web",
                new=AsyncMock(
                    side_effect=lambda **_: event_order.append("user_message")
                ),
            ) as broadcast_mock,
            patch(
                "app.services.chat.storage.task_manager.create_task_and_subtasks",
                new=AsyncMock(return_value=creation_result),
            ) as create_task_mock,
            patch(
                "app.services.execution.schedule_dispatch",
                side_effect=lambda _: event_order.append("dispatch"),
            ) as schedule_dispatch,
        ):
            result = await handler._create_and_process_cloud_task(
                db=db,
                user=user,
                team=team,
                message_context=message_context,
            )

        assert result is None
        broadcast_mock.assert_awaited_once_with(
            db=db,
            task_id=creation_result.task.id,
            user_subtask=creation_result.user_subtask,
            message=message_context.content,
            user=user,
        )
        assert event_order[:2] == ["user_message", "dispatch"]
        schedule_dispatch.assert_called_once_with(creation_result.task.id)
        _assert_message_source(create_task_mock)

    @pytest.mark.asyncio
    async def test_broadcast_user_message_to_web_includes_display_metadata(
        self, handler
    ):
        created_at = datetime(2026, 9, 8, 15, 39, 46)
        user = SimpleNamespace(id=1, user_name="Test User")
        user_subtask = SimpleNamespace(
            id=300,
            message_id=5,
            created_at=created_at,
            result={"source": EXPECTED_IM_SOURCE},
        )
        context = MagicMock()
        context.model_dump.return_value = {
            "id": 400,
            "context_type": "attachment",
        }
        websocket_emitter = SimpleNamespace(emit_chat_message=AsyncMock())
        db = MagicMock()

        with (
            patch(
                "app.services.chat.webpage_ws_chat_emitter.get_webpage_ws_emitter",
                return_value=websocket_emitter,
            ),
            patch(
                "app.services.context.context_service.context_service."
                "get_briefs_by_subtask",
                return_value=[context],
            ) as get_contexts_mock,
        ):
            await handler._broadcast_user_message_to_web(
                db=db,
                task_id=200,
                user_subtask=user_subtask,
                message="Hello from Telegram",
                user=user,
            )

        get_contexts_mock.assert_called_once_with(db, user_subtask.id)
        context.model_dump.assert_called_once_with(mode="json")
        websocket_emitter.emit_chat_message.assert_awaited_once_with(
            task_id=200,
            subtask_id=user_subtask.id,
            message_id=user_subtask.message_id,
            role="user",
            content="Hello from Telegram",
            sender={"user_id": user.id, "user_name": user.user_name},
            created_at=created_at,
            attachment=None,
            attachments=[],
            contexts=[{"id": 400, "context_type": "attachment"}],
            source=EXPECTED_IM_SOURCE,
        )

    @pytest.mark.asyncio
    async def test_private_im_task_response_failure_marks_task_failed(self, handler):
        message_context = _message_context()
        task = SimpleNamespace(id=33, json={"status": {"status": "PENDING"}})
        assistant_subtask = SimpleNamespace(
            id=52,
            status=SubtaskStatus.PENDING,
            progress=0,
            error_message="",
            completed_at=None,
        )
        db = MagicMock()

        with (
            patch.object(
                handler,
                "create_streaming_emitter",
                new=AsyncMock(return_value=None),
            ),
            patch.object(handler, "_register_streaming_emitter", new=AsyncMock()),
            patch.object(handler, "send_text_reply", new=AsyncMock()) as send_reply,
            patch(
                "app.services.chat.trigger.trigger_ai_response_unified",
                new=AsyncMock(side_effect=ValueError("Model codex-gpt-5.5 not found")),
            ),
        ):
            await handler._trigger_private_im_task_response(
                db=db,
                task=task,
                assistant_subtask=assistant_subtask,
                team=SimpleNamespace(id=38),
                user=SimpleNamespace(id=1),
                user_subtask_id=51,
                message="我刚才说的啥",
                message_context=message_context,
                params=SimpleNamespace(is_group_chat=False),
            )

        assert task.json["status"]["status"] == "FAILED"
        assert "Model codex-gpt-5.5 not found" in task.json["status"]["errorMessage"]
        assert assistant_subtask.status == SubtaskStatus.FAILED
        assert assistant_subtask.progress == 100
        assert "Model codex-gpt-5.5 not found" in assistant_subtask.error_message
        db.commit.assert_called_once()
        send_reply.assert_awaited_once()
        assert "任务执行失败" in send_reply.await_args.args[1]

    @pytest.mark.asyncio
    async def test_private_im_task_response_routes_existing_device_task_to_device(
        self, handler
    ):
        message_context = _message_context()
        task = SimpleNamespace(
            id=33,
            json={"spec": {"device_id": "hw-4e4bfa88fa25"}},
        )
        assistant_subtask = SimpleNamespace(id=54)
        streaming_emitter = _streaming_emitter()

        with (
            patch.object(
                handler,
                "create_streaming_emitter",
                new=AsyncMock(return_value=streaming_emitter),
            ),
            patch.object(handler, "_register_streaming_emitter", new=AsyncMock()),
            patch(
                "app.services.chat.trigger.trigger_ai_response_unified",
                new=AsyncMock(),
            ) as trigger_mock,
        ):
            await handler._trigger_private_im_task_response(
                db=MagicMock(),
                task=task,
                assistant_subtask=assistant_subtask,
                team=SimpleNamespace(id=38),
                user=SimpleNamespace(id=1),
                user_subtask_id=53,
                message="继续",
                message_context=message_context,
                params=SimpleNamespace(is_group_chat=False),
            )

        assert trigger_mock.await_args.kwargs["device_id"] == "hw-4e4bfa88fa25"
        assert trigger_mock.await_args.kwargs["result_emitter"] is None

    @pytest.mark.asyncio
    async def test_private_im_continue_task_reports_running_task(self, handler):
        message_context = _message_context()
        db = MagicMock()
        user = SimpleNamespace(id=1)
        im_session = SimpleNamespace(active_task_id=33)
        task = SimpleNamespace(id=33)

        with (
            patch(
                "app.services.channels.handler.im_task_continuation_service.validate_personal_wework_task",
                return_value=task,
            ),
            patch(
                "app.services.channels.handler.im_task_continuation_service.get_task_team",
                return_value=SimpleNamespace(id=38),
            ),
            patch.object(
                handler,
                "_build_private_im_message_source",
                return_value=EXPECTED_IM_SOURCE,
            ),
            patch(
                "app.services.channels.handler.im_task_continuation_service.append_message_to_task",
                new=AsyncMock(
                    side_effect=HTTPException(
                        status_code=400,
                        detail="Task is still running",
                    )
                ),
            ),
            patch.object(handler, "send_text_reply", new=AsyncMock()) as send_reply,
        ):
            await handler._execute_private_im_continue_task(
                db=db,
                user=user,
                im_session=im_session,
                task_id=33,
                message="我刚才说的啥",
                message_context=message_context,
            )

        send_reply.assert_awaited_once()
        assert "当前任务仍在执行" in send_reply.await_args.args[1]
