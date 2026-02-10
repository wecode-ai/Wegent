# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Telegram Channel Handler.

This module provides the handler for processing incoming Telegram messages
and integrating them with the Wegent chat system.

Supports multiple execution modes:
- Chat Shell: Direct LLM conversation (default)
- Local Device: Execute tasks on user's local device
- Cloud Executor: Execute tasks on cloud Docker container

Architecture:
- TelegramChannelHandler: Implements BaseChannelHandler for Telegram-specific logic
- Handles both text messages and callback queries (inline keyboard interactions)
"""

import logging
from typing import TYPE_CHECKING, Any, Callable, Dict, Optional

from sqlalchemy.orm import Session

from app.db.session import SessionLocal
from app.models.user import User
from app.services.channels.callback import BaseChannelCallbackService, ChannelType
from app.services.channels.handler import BaseChannelHandler, MessageContext
from app.services.channels.telegram.callback import (
    TelegramCallbackInfo,
    telegram_callback_service,
)
from app.services.channels.telegram.emitter import StreamingResponseEmitter
from app.services.channels.telegram.keyboard import (
    CallbackAction,
    TelegramKeyboardBuilder,
)
from app.services.channels.telegram.user_resolver import TelegramUserResolver
from app.services.execution.emitters import ResultEmitter

if TYPE_CHECKING:
    from telegram import Bot, Message, Update

logger = logging.getLogger(__name__)


class TelegramChannelHandler(BaseChannelHandler["Update", TelegramCallbackInfo]):
    """Telegram-specific implementation of BaseChannelHandler.

    This class implements all the abstract methods from BaseChannelHandler
    with Telegram-specific logic for message parsing, user resolution,
    and response sending.
    """

    def __init__(
        self,
        channel_id: int,
        bot: Optional["Bot"] = None,
        use_inline_keyboard: bool = True,
        get_default_team_id: Optional[Callable[[], Optional[int]]] = None,
        get_default_model_name: Optional[Callable[[], Optional[str]]] = None,
        get_user_mapping_config: Optional[Callable[[], Dict[str, Any]]] = None,
    ):
        """Initialize the Telegram channel handler.

        Args:
            channel_id: The IM channel ID for callback purposes
            bot: Telegram Bot instance for sending responses
            use_inline_keyboard: Whether to use inline keyboard for commands
            get_default_team_id: Callback to get current default_team_id dynamically
            get_default_model_name: Callback to get current default_model_name dynamically
            get_user_mapping_config: Callback to get user mapping configuration dynamically
        """
        super().__init__(
            channel_type=ChannelType.TELEGRAM,
            channel_id=channel_id,
            get_default_team_id=get_default_team_id,
            get_default_model_name=get_default_model_name,
            get_user_mapping_config=get_user_mapping_config,
        )
        self._bot = bot
        self._use_inline_keyboard = use_inline_keyboard
        # Store current message context for reply operations
        self._current_chat_id: Optional[int] = None
        self._current_message_id: Optional[int] = None

    def set_bot(self, bot: "Bot") -> None:
        """Set the Telegram bot (can be set after initialization)."""
        self._bot = bot

    def parse_message(self, raw_data: Any) -> MessageContext:
        """Parse Telegram Update into generic MessageContext.

        Args:
            raw_data: Update object from Telegram Bot API

        Returns:
            MessageContext with parsed message information
        """
        update: "Update" = raw_data

        # Handle callback query (inline keyboard button press)
        if update.callback_query:
            query = update.callback_query
            user = query.from_user

            self._current_chat_id = query.message.chat_id if query.message else 0
            self._current_message_id = query.message.message_id if query.message else 0

            return MessageContext(
                content=query.data or "",  # Callback data as content
                sender_id=str(user.id) if user else "",
                sender_name=(user.first_name or user.username) if user else None,
                conversation_id=str(self._current_chat_id),
                conversation_type=(
                    "private"
                    if query.message and query.message.chat.type == "private"
                    else "group"
                ),
                is_mention=False,
                raw_message=update,
                extra_data={
                    "telegram_user_id": user.id if user else 0,
                    "telegram_username": user.username if user else None,
                    "telegram_first_name": user.first_name if user else None,
                    "telegram_last_name": user.last_name if user else None,
                    "is_callback_query": True,
                    "callback_query_id": query.id,
                },
            )

        # Handle regular message
        message = update.message or update.edited_message
        if not message:
            # Return empty context for non-message updates
            return MessageContext(
                content="",
                sender_id="",
                sender_name=None,
                conversation_id="",
                conversation_type="private",
                is_mention=False,
                raw_message=update,
                extra_data={},
            )

        user = message.from_user
        self._current_chat_id = message.chat_id
        self._current_message_id = message.message_id

        # Extract text content
        content = message.text or ""

        # Check if bot was mentioned (for group chats)
        is_mention = False
        if message.entities:
            for entity in message.entities:
                if entity.type == "mention":
                    is_mention = True
                    break

        return MessageContext(
            content=content,
            sender_id=str(user.id) if user else "",
            sender_name=user.first_name if user else None,
            conversation_id=str(message.chat_id),
            conversation_type="private" if message.chat.type == "private" else "group",
            is_mention=is_mention,
            raw_message=update,
            extra_data={
                "telegram_user_id": user.id if user else 0,
                "telegram_username": user.username if user else None,
                "telegram_first_name": user.first_name if user else None,
                "telegram_last_name": user.last_name if user else None,
                "is_callback_query": False,
            },
        )

    async def resolve_user(
        self, db: Session, message_context: MessageContext
    ) -> Optional[User]:
        """Resolve Telegram user to Wegent user.

        Args:
            db: Database session
            message_context: Parsed message context

        Returns:
            Wegent User or None if not found
        """
        mapping_config = self.user_mapping_config
        resolver = TelegramUserResolver(
            db,
            user_mapping_mode=mapping_config.mode,
            user_mapping_config=mapping_config.config,
        )
        return await resolver.resolve_user(
            telegram_user_id=message_context.extra_data.get("telegram_user_id", 0),
            telegram_username=message_context.extra_data.get("telegram_username"),
            telegram_first_name=message_context.extra_data.get("telegram_first_name"),
            telegram_last_name=message_context.extra_data.get("telegram_last_name"),
        )

    async def send_text_reply(self, message_context: MessageContext, text: str) -> bool:
        """Send a text reply to Telegram.

        Args:
            message_context: Original message context
            text: Text to send

        Returns:
            True if sent successfully, False otherwise
        """
        if not self._bot:
            self.logger.error("[TelegramHandler] No bot instance available for reply")
            return False

        chat_id = (
            int(message_context.conversation_id)
            if message_context.conversation_id
            else self._current_chat_id
        )
        if not chat_id:
            self.logger.error("[TelegramHandler] No chat_id available for reply")
            return False

        try:
            await self._bot.send_message(
                chat_id=chat_id,
                text=text,
            )
            return True
        except Exception as e:
            self.logger.exception(f"[TelegramHandler] Failed to send reply: {e}")
            return False

    def create_callback_info(
        self, message_context: MessageContext
    ) -> TelegramCallbackInfo:
        """Create Telegram callback info for task completion notification.

        Args:
            message_context: Message context

        Returns:
            TelegramCallbackInfo instance
        """
        chat_id = (
            int(message_context.conversation_id)
            if message_context.conversation_id
            else 0
        )
        return TelegramCallbackInfo(
            channel_id=self._channel_id,
            conversation_id=message_context.conversation_id,
            chat_id=chat_id,
        )

    def get_callback_service(self) -> Optional[BaseChannelCallbackService]:
        """Get the Telegram callback service.

        Returns:
            TelegramCallbackService instance
        """
        return telegram_callback_service

    async def create_streaming_emitter(
        self, message_context: MessageContext
    ) -> Optional[ResultEmitter]:
        """Create a streaming emitter for Telegram message editing.

        Args:
            message_context: Message context

        Returns:
            StreamingResponseEmitter or None if not supported
        """
        if not self._bot:
            return None

        chat_id = (
            int(message_context.conversation_id)
            if message_context.conversation_id
            else self._current_chat_id
        )
        if not chat_id:
            return None

        return StreamingResponseEmitter(
            bot=self._bot,
            chat_id=chat_id,
        )

    async def handle_callback_query(
        self, update: "Update", user: User
    ) -> Optional[str]:
        """Handle inline keyboard callback query.

        Args:
            update: Telegram Update with callback_query
            user: Resolved Wegent user

        Returns:
            Response message or None
        """
        query = update.callback_query
        if not query:
            return None

        # Answer the callback query to remove loading indicator
        try:
            await query.answer()
        except Exception as e:
            self.logger.warning(
                f"[TelegramHandler] Failed to answer callback query: {e}"
            )

        # Parse callback data
        action, value = TelegramKeyboardBuilder.parse_callback_data(query.data or "")

        if action == CallbackAction.CANCEL.value:
            # Delete the keyboard message
            try:
                if query.message:
                    await query.message.delete()
            except Exception:
                self.logger.debug(
                    "[TelegramHandler] Failed to delete keyboard message", exc_info=True
                )
            return None

        if action == CallbackAction.SELECT_MODEL.value:
            return await self._handle_model_callback(user, value)

        if action == CallbackAction.SELECT_DEVICE.value:
            return await self._handle_device_callback(user, value)

        if action == CallbackAction.SET_MODE.value:
            return await self._handle_mode_callback(user, value)

        return None

    async def _handle_model_callback(self, user: User, value: str) -> Optional[str]:
        """Handle model selection callback."""
        from app.services.channels.model_selection import (
            ModelSelection,
            model_selection_manager,
        )
        from app.services.model_aggregation_service import model_aggregation_service

        db = SessionLocal()
        try:
            # Get available models
            all_models = model_aggregation_service.list_available_models(
                db=db,
                current_user=user,
                shell_type=None,
                include_config=False,
                scope="personal",
                model_category_type="llm",
            )

            if not all_models:
                return "❌ 暂无可用模型"

            # Parse model index
            try:
                model_index = int(value)
                if model_index < 1 or model_index > len(all_models):
                    return f"❌ 无效的模型序号: {value}"
            except ValueError:
                return f"❌ 无效的模型序号: {value}"

            selected = all_models[model_index - 1]

            # Save selection
            new_selection = ModelSelection(
                model_name=selected.get("name", ""),
                model_type=selected.get("type", "public"),
                display_name=selected.get("displayName"),
                provider=selected.get("provider"),
            )
            await model_selection_manager.set_selection(user.id, new_selection)

            display_name = new_selection.display_name or new_selection.model_name
            return f"✅ 已切换到模型 **{display_name}**"

        finally:
            db.close()

    async def _handle_device_callback(self, user: User, value: str) -> Optional[str]:
        """Handle device selection callback."""
        from app.services.channels.device_selection import device_selection_manager
        from app.services.device_service import device_service

        db = SessionLocal()
        try:
            devices = await device_service.get_all_devices(db, user.id)
            online_devices = [d for d in devices if d.get("status") != "offline"]

            if not online_devices:
                return "❌ 暂无在线设备"

            # Parse device index
            try:
                device_index = int(value)
                if device_index < 1 or device_index > len(online_devices):
                    return f"❌ 无效的设备序号: {value}"
            except ValueError:
                return f"❌ 无效的设备序号: {value}"

            selected = online_devices[device_index - 1]

            await device_selection_manager.set_local_device(
                user.id,
                selected["device_id"],
                selected["name"],
            )

            return f"✅ 已切换到设备 **{selected['name']}**"

        finally:
            db.close()

    async def _handle_mode_callback(self, user: User, value: str) -> Optional[str]:
        """Handle execution mode selection callback."""
        from app.services.channels.device_selection import device_selection_manager

        if value == "chat":
            await device_selection_manager.set_chat_mode(user.id)
            return "✅ 已切换到**对话模式**"

        if value == "cloud":
            await device_selection_manager.set_cloud_executor(user.id)
            return "✅ 已切换到**云端执行模式**"

        if value == "device":
            # Check if user has a device selected
            selection = await device_selection_manager.get_selection(user.id)
            if selection.device_id:
                # Actually switch to device mode by setting the device
                await device_selection_manager.set_local_device(
                    user.id, selection.device_id, selection.device_name
                )
                return "✅ 已切换到**设备模式**"
            else:
                return "❌ 尚未选择设备,请先使用 `/devices` 选择一个设备"

        return f"❌ 未知的执行模式: {value}"

    async def send_models_keyboard(
        self, message_context: MessageContext, user: User
    ) -> bool:
        """Send models list with inline keyboard.

        Args:
            message_context: Message context
            user: Wegent user

        Returns:
            True if sent successfully
        """
        if not self._bot or not self._use_inline_keyboard:
            return False

        from app.services.channels.model_selection import model_selection_manager
        from app.services.model_aggregation_service import model_aggregation_service

        db = SessionLocal()
        try:
            # Get available models
            all_models = model_aggregation_service.list_available_models(
                db=db,
                current_user=user,
                shell_type=None,
                include_config=False,
                scope="personal",
                model_category_type="llm",
            )

            if not all_models:
                await self.send_text_reply(message_context, "暂无可用模型")
                return True

            # Get current selection
            current_selection = await model_selection_manager.get_selection(user.id)
            current_model_name = (
                current_selection.model_name if current_selection else None
            )

            # Build keyboard
            keyboard = TelegramKeyboardBuilder.build_models_keyboard(
                all_models, current_model_name
            )

            chat_id = (
                int(message_context.conversation_id)
                if message_context.conversation_id
                else self._current_chat_id
            )
            if not chat_id:
                self.logger.error(
                    "[TelegramHandler] No chat_id available for models keyboard"
                )
                return False
            await self._bot.send_message(
                chat_id=chat_id,
                text="🤖 **可用模型列表**\n\n选择一个模型:",
                reply_markup=keyboard,
            )
            return True

        except Exception as e:
            self.logger.exception(
                f"[TelegramHandler] Failed to send models keyboard: {e}"
            )
            return False
        finally:
            db.close()

    async def send_devices_keyboard(
        self, message_context: MessageContext, user: User
    ) -> bool:
        """Send devices list with inline keyboard.

        Args:
            message_context: Message context
            user: Wegent user

        Returns:
            True if sent successfully
        """
        if not self._bot or not self._use_inline_keyboard:
            return False

        from app.services.channels.device_selection import (
            DeviceType,
            device_selection_manager,
        )
        from app.services.device_service import device_service

        db = SessionLocal()
        try:
            devices = await device_service.get_all_devices(db, user.id)

            if not devices:
                await self.send_text_reply(
                    message_context,
                    "暂无在线设备\n\n💡 在本地运行 Executor 后设备会自动出现",
                )
                return True

            # Get current selection
            current_selection = await device_selection_manager.get_selection(user.id)
            current_device_id = (
                current_selection.device_id
                if current_selection.device_type == DeviceType.LOCAL
                else None
            )

            # Build keyboard
            keyboard = TelegramKeyboardBuilder.build_devices_keyboard(
                devices, current_device_id
            )

            chat_id = (
                int(message_context.conversation_id)
                if message_context.conversation_id
                else self._current_chat_id
            )
            if not chat_id:
                self.logger.error(
                    "[TelegramHandler] No chat_id available for devices keyboard"
                )
                return False
            await self._bot.send_message(
                chat_id=chat_id,
                text="📱 **在线设备列表**\n\n选择一个设备:",
                reply_markup=keyboard,
            )
            return True

        except Exception as e:
            self.logger.exception(
                f"[TelegramHandler] Failed to send devices keyboard: {e}"
            )
            return False
        finally:
            db.close()

    async def send_mode_keyboard(
        self, message_context: MessageContext, user: User
    ) -> bool:
        """Send execution mode selection with inline keyboard.

        Args:
            message_context: Message context
            user: Wegent user

        Returns:
            True if sent successfully
        """
        if not self._bot or not self._use_inline_keyboard:
            return False

        from app.services.channels.device_selection import (
            DeviceType,
            device_selection_manager,
        )

        try:
            # Get current mode
            selection = await device_selection_manager.get_selection(user.id)
            current_mode = None
            if selection.device_type == DeviceType.CHAT:
                current_mode = "chat"
            elif selection.device_type == DeviceType.LOCAL:
                current_mode = "device"
            elif selection.device_type == DeviceType.CLOUD:
                current_mode = "cloud"

            # Build keyboard
            keyboard = TelegramKeyboardBuilder.build_mode_keyboard(current_mode)

            chat_id = (
                int(message_context.conversation_id)
                if message_context.conversation_id
                else self._current_chat_id
            )
            if not chat_id:
                self.logger.error(
                    "[TelegramHandler] No chat_id available for mode keyboard"
                )
                return False
            await self._bot.send_message(
                chat_id=chat_id,
                text="🔧 **执行模式**\n\n选择执行模式:",
                reply_markup=keyboard,
            )
            return True

        except Exception as e:
            self.logger.exception(
                f"[TelegramHandler] Failed to send mode keyboard: {e}"
            )
            return False
