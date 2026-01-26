# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Telegram Provider Implementation.

Implements the IMProvider interface for Telegram using the python-telegram-bot library.
Supports both polling mode (for development) and webhook mode (for production).
"""

import asyncio
import logging
from datetime import datetime, timezone
from typing import Callable, Optional

from app.services.im.base.message import (
    IMMessage,
    IMMessageType,
    IMOutboundMessage,
    IMPlatform,
    IMUser,
)
from app.services.im.base.provider import IMProvider
from app.services.im.providers.telegram.formatter import TelegramFormatter
from app.services.im.registry import IMProviderRegistry

logger = logging.getLogger(__name__)


# Try to import telegram library - it's optional
try:
    from telegram import Bot, Update
    from telegram.constants import ParseMode
    from telegram.ext import (
        Application,
        CommandHandler,
        ContextTypes,
        MessageHandler,
        filters,
    )

    TELEGRAM_AVAILABLE = True
except ImportError:
    TELEGRAM_AVAILABLE = False
    logger.warning(
        "python-telegram-bot not installed. Telegram provider will not be available."
    )


@IMProviderRegistry.register(IMPlatform.TELEGRAM)
class TelegramProvider(IMProvider):
    """
    Telegram Provider Implementation.

    Uses python-telegram-bot library for Telegram Bot API interaction.
    Supports polling mode for message receiving.
    """

    def __init__(self):
        super().__init__()
        self._application: Optional["Application"] = None
        self._formatter = TelegramFormatter()
        self._running = False
        self._token: Optional[str] = None

    @property
    def platform(self) -> IMPlatform:
        return IMPlatform.TELEGRAM

    async def initialize(self, config: dict) -> bool:
        """
        Initialize the Telegram bot.

        Args:
            config: Configuration dict with 'token' key

        Returns:
            True if initialization successful
        """
        if not TELEGRAM_AVAILABLE:
            logger.error("python-telegram-bot is not installed")
            return False

        token = config.get("token")
        if not token:
            logger.error("Telegram token not provided")
            return False

        self._token = token

        try:
            self._application = Application.builder().token(token).build()

            # Register command handlers
            self._application.add_handler(
                CommandHandler("start", self._on_command)
            )
            self._application.add_handler(
                CommandHandler("new", self._on_command)
            )
            self._application.add_handler(
                CommandHandler("help", self._on_command)
            )

            # Register text message handler
            self._application.add_handler(
                MessageHandler(
                    filters.TEXT & ~filters.COMMAND,
                    self._on_message,
                )
            )

            logger.info("Telegram bot initialized successfully")
            return True

        except Exception as e:
            logger.error(f"Failed to initialize Telegram bot: {e}")
            return False

    async def start(self) -> None:
        """Start the bot in polling mode."""
        if not self._application:
            raise RuntimeError("Provider not initialized")

        self._running = True

        try:
            await self._application.initialize()
            await self._application.start()
            await self._application.updater.start_polling(
                drop_pending_updates=True
            )
            logger.info("Telegram bot started polling")
        except Exception as e:
            self._running = False
            logger.error(f"Failed to start Telegram bot: {e}")
            raise

    async def stop(self) -> None:
        """Stop the bot."""
        if not self._application or not self._running:
            return

        self._running = False

        try:
            if self._application.updater and self._application.updater.running:
                await self._application.updater.stop()
            await self._application.stop()
            await self._application.shutdown()
            logger.info("Telegram bot stopped")
        except Exception as e:
            logger.error(f"Error stopping Telegram bot: {e}")

    async def send_message(
        self,
        chat_id: str,
        message: IMOutboundMessage,
    ) -> bool:
        """
        Send a message to a Telegram chat.

        Args:
            chat_id: Telegram chat ID
            message: Message to send

        Returns:
            True if sent successfully
        """
        if not self._application:
            return False

        try:
            bot = self._application.bot

            # Format the message for Telegram
            formatted = self._formatter.format_markdown(message.content)

            # Split into chunks if necessary
            chunks = self._formatter.split_message(formatted)

            for chunk in chunks:
                try:
                    # Try MarkdownV2 first
                    await bot.send_message(
                        chat_id=int(chat_id),
                        text=chunk,
                        parse_mode=ParseMode.MARKDOWN_V2,
                    )
                except Exception as e:
                    # Fall back to plain text if Markdown parsing fails
                    logger.warning(f"Markdown parsing failed, falling back to plain text: {e}")
                    await bot.send_message(
                        chat_id=int(chat_id),
                        text=message.content,
                    )
                    break

            return True

        except Exception as e:
            logger.error(f"Failed to send Telegram message: {e}")
            return False

    async def send_typing_indicator(self, chat_id: str) -> None:
        """Send typing indicator to show the bot is processing."""
        if not self._application:
            return

        try:
            await self._application.bot.send_chat_action(
                chat_id=int(chat_id),
                action="typing",
            )
        except Exception as e:
            logger.debug(f"Failed to send typing indicator: {e}")

    async def validate_config(self, config: dict) -> tuple[bool, Optional[str]]:
        """
        Validate Telegram bot token.

        Args:
            config: Configuration with 'token' key

        Returns:
            Tuple of (is_valid, error_message)
        """
        if not TELEGRAM_AVAILABLE:
            return False, "python-telegram-bot library is not installed"

        token = config.get("token")
        if not token:
            return False, "Token is required"

        try:
            bot = Bot(token=token)
            await bot.get_me()
            return True, None
        except Exception as e:
            return False, f"Invalid token: {str(e)}"

    async def get_bot_info(self, config: dict) -> Optional[dict]:
        """
        Get Telegram bot information.

        Args:
            config: Configuration with 'token' key

        Returns:
            Bot information dict or None
        """
        if not TELEGRAM_AVAILABLE:
            return None

        token = config.get("token")
        if not token:
            return None

        try:
            bot = Bot(token=token)
            me = await bot.get_me()
            return {
                "id": me.id,
                "username": me.username,
                "first_name": me.first_name,
                "can_join_groups": me.can_join_groups,
                "can_read_all_group_messages": me.can_read_all_group_messages,
            }
        except Exception as e:
            logger.error(f"Failed to get bot info: {e}")
            return None

    async def _on_command(
        self,
        update: "Update",
        context: "ContextTypes.DEFAULT_TYPE",
    ) -> None:
        """Handle command messages."""
        if not update.message or not self._message_handler:
            return

        message = self._convert_to_im_message(update, is_command=True)
        await self._message_handler(message)

    async def _on_message(
        self,
        update: "Update",
        context: "ContextTypes.DEFAULT_TYPE",
    ) -> None:
        """Handle text messages."""
        if not update.message or not self._message_handler:
            return

        message = self._convert_to_im_message(update, is_command=False)
        await self._message_handler(message)

    def _convert_to_im_message(
        self,
        update: "Update",
        is_command: bool,
    ) -> IMMessage:
        """
        Convert Telegram Update to unified IMMessage.

        Args:
            update: Telegram Update object
            is_command: Whether this is a command message

        Returns:
            Unified IMMessage
        """
        tg_message = update.message
        tg_user = tg_message.from_user

        # Create unified user model
        user = IMUser(
            platform=IMPlatform.TELEGRAM,
            platform_user_id=str(tg_user.id),
            username=tg_user.username,
            display_name=tg_user.full_name,
        )

        # Parse command if present
        command = None
        command_args = None
        content = tg_message.text or ""

        if is_command and content.startswith("/"):
            parts = content.split(maxsplit=1)
            # Remove / prefix and @botname suffix
            command = parts[0][1:].split("@")[0]
            command_args = parts[1] if len(parts) > 1 else None

        return IMMessage(
            platform=IMPlatform.TELEGRAM,
            message_id=str(tg_message.message_id),
            chat_id=str(tg_message.chat_id),
            user=user,
            message_type=IMMessageType.COMMAND if is_command else IMMessageType.TEXT,
            content=content,
            command=command,
            command_args=command_args,
            timestamp=tg_message.date or datetime.now(timezone.utc),
            raw_data=update.to_dict() if update else None,
        )
