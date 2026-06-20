# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Unit tests for TelegramChannelHandler."""

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.services.channels.callback import ChannelType
from app.services.channels.handler import MessageContext
from app.services.channels.telegram.handler import TelegramChannelHandler


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
        message_context = MessageContext(
            content="Hello from Telegram",
            sender_id="12345",
            sender_name="Test",
            conversation_id="67890",
            conversation_type="private",
            is_mention=False,
            raw_message=MagicMock(),
            extra_data={},
        )
        user = SimpleNamespace(id=1)
        team = SimpleNamespace(id=100)
        task = SimpleNamespace(id=200)
        user_subtask = SimpleNamespace(id=300)
        assistant_subtask = SimpleNamespace(id=301)
        creation_result = SimpleNamespace(
            task=task,
            user_subtask=user_subtask,
            assistant_subtask=assistant_subtask,
        )
        db = MagicMock()
        streaming_emitter = SimpleNamespace(
            emit_start=AsyncMock(),
            set_shared_content_key=MagicMock(),
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
            patch(
                "app.services.chat.storage.task_manager.create_task_and_subtasks",
                new=AsyncMock(return_value=creation_result),
            ) as create_task_mock,
            patch(
                "app.services.chat.trigger.trigger_ai_response_unified",
                new=AsyncMock(),
            ),
        ):
            result = await handler._create_and_process_chat(user, message_context)

        assert result is None
        params = create_task_mock.await_args.kwargs["params"]
        assert params.message_source == {
            "source": "im",
            "channel_type": "telegram",
            "channel_label": "Telegram",
        }
