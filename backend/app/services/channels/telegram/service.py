# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Telegram Channel Provider.

This module provides the channel provider for Telegram Bot integration.
It manages the Telegram Bot lifecycle using Long Polling mode.

IM channels are stored as Messager CRD in the kinds table.
"""

import asyncio
import logging
from typing import Any, Dict, Optional

from telegram import Update
from telegram.ext import (
    Application,
    CallbackQueryHandler,
    CommandHandler,
    ContextTypes,
    MessageHandler,
    filters,
)

from app.core.cache import cache_manager
from app.db.session import SessionLocal
from app.services.channels.base import BaseChannelProvider
from app.services.channels.commands import CommandType, parse_command
from app.services.channels.telegram.handler import TelegramChannelHandler

logger = logging.getLogger(__name__)

# CRD kind for IM channels
MESSAGER_KIND = "Messager"
MESSAGER_USER_ID = 0

# Message deduplication settings
TELEGRAM_MSG_DEDUP_PREFIX = "telegram:msg_dedup:"
TELEGRAM_MSG_DEDUP_TTL = 300  # 5 minutes


def _get_channel_default_team_id(channel_id: int) -> Optional[int]:
    """
    Get the current default_team_id for a channel from database.

    This function is used by the handler to dynamically get the latest
    default_team_id, allowing configuration updates without restart.

    Args:
        channel_id: The IM channel ID (Kind.id)

    Returns:
        The default team ID or None
    """
    from app.models.kind import Kind

    db = SessionLocal()
    try:
        channel = (
            db.query(Kind)
            .filter(
                Kind.id == channel_id,
                Kind.kind == MESSAGER_KIND,
                Kind.user_id == MESSAGER_USER_ID,
                Kind.is_active == True,
            )
            .first()
        )
        if channel:
            spec = channel.json.get("spec", {})
            return spec.get("defaultTeamId", 0)
        return None
    finally:
        db.close()


def _get_channel_default_model_name(channel_id: int) -> Optional[str]:
    """
    Get the current default_model_name for a channel from database.

    Args:
        channel_id: The IM channel ID (Kind.id)

    Returns:
        The default model name or None
    """
    from app.models.kind import Kind

    db = SessionLocal()
    try:
        channel = (
            db.query(Kind)
            .filter(
                Kind.id == channel_id,
                Kind.kind == MESSAGER_KIND,
                Kind.user_id == MESSAGER_USER_ID,
                Kind.is_active == True,
            )
            .first()
        )
        if channel:
            spec = channel.json.get("spec", {})
            model_name = spec.get("defaultModelName", "")
            return model_name if model_name else None
        return None
    finally:
        db.close()


def _get_channel_user_mapping_config(channel_id: int) -> Dict[str, Any]:
    """
    Get the user mapping configuration for a channel from database.

    Args:
        channel_id: The IM channel ID (Kind.id)

    Returns:
        Dict with user_mapping_mode and user_mapping_config.
    """
    from app.models.kind import Kind

    db = SessionLocal()
    try:
        channel = (
            db.query(Kind)
            .filter(
                Kind.id == channel_id,
                Kind.kind == MESSAGER_KIND,
                Kind.user_id == MESSAGER_USER_ID,
                Kind.is_active == True,
            )
            .first()
        )
        if channel:
            spec = channel.json.get("spec", {})
            config = spec.get("config", {})
            return {
                "mode": config.get("user_mapping_mode", "select_user"),
                "config": config.get("user_mapping_config"),
            }
        return {"mode": "select_user", "config": None}
    finally:
        db.close()


class TelegramChannelProvider(BaseChannelProvider):
    """
    Telegram channel provider using Long Polling.

    Manages the Telegram Bot lifecycle, including:
    - Starting and stopping the bot
    - Processing incoming messages
    - Handling inline keyboard callbacks
    - Message deduplication
    """

    def __init__(self, channel: Any):
        """
        Initialize the Telegram channel provider.

        Args:
            channel: Channel-like object (IMChannelAdapter) with Telegram configuration
        """
        super().__init__(channel)
        self._application: Optional[Application] = None
        self._bot: Optional[Any] = None  # telegram.Bot instance
        self._handler: Optional[TelegramChannelHandler] = None
        self._task: Optional[asyncio.Task] = None

    @property
    def bot_token(self) -> Optional[str]:
        """Get the Telegram bot token from config."""
        return self.config.get("bot_token")

    @property
    def use_inline_keyboard(self) -> bool:
        """Whether to use inline keyboard for commands."""
        return self.config.get("use_inline_keyboard", True)

    def _is_configured(self) -> bool:
        """Check if Telegram is properly configured."""
        return bool(self.bot_token)

    async def start(self) -> bool:
        """
        Start the Telegram Bot with Long Polling.

        Returns:
            True if started successfully, False otherwise
        """
        if not self._is_configured():
            self._set_error("Telegram not configured: missing bot_token")
            return False

        if self._is_running:
            logger.warning(
                "[Telegram] Channel %s (id=%d) is already running",
                self.channel_name,
                self.channel_id,
            )
            return True

        try:
            logger.info(
                "[Telegram] Starting channel %s (id=%d)...",
                self.channel_name,
                self.channel_id,
            )

            # Create application with bot token
            self._application = Application.builder().token(self.bot_token).build()
            self._bot = self._application.bot

            # Create handler with dynamic configuration getters
            channel_id = self.channel_id
            self._handler = TelegramChannelHandler(
                channel_id=channel_id,
                bot=self._bot,
                use_inline_keyboard=self.use_inline_keyboard,
                get_default_team_id=lambda: _get_channel_default_team_id(channel_id),
                get_default_model_name=lambda: _get_channel_default_model_name(
                    channel_id
                ),
                get_user_mapping_config=lambda: _get_channel_user_mapping_config(
                    channel_id
                ),
            )

            # Register handlers
            self._application.add_handler(
                CommandHandler("start", self._handle_start_command)
            )
            self._application.add_handler(
                CommandHandler("help", self._handle_help_command)
            )
            self._application.add_handler(
                CommandHandler("new", self._handle_new_command)
            )
            self._application.add_handler(
                CommandHandler("status", self._handle_status_command)
            )
            self._application.add_handler(
                CommandHandler("models", self._handle_models_command)
            )
            self._application.add_handler(
                CommandHandler("devices", self._handle_devices_command)
            )
            self._application.add_handler(
                CommandHandler("use", self._handle_use_command)
            )
            self._application.add_handler(
                CallbackQueryHandler(self._handle_callback_query)
            )
            self._application.add_handler(
                MessageHandler(filters.TEXT & ~filters.COMMAND, self._handle_message)
            )

            # Initialize and start polling in background
            await self._application.initialize()
            self._task = asyncio.create_task(self._run_polling())
            self._set_running(True)

            logger.info(
                "[Telegram] Channel %s (id=%d) started successfully",
                self.channel_name,
                self.channel_id,
            )
            return True

        except Exception as e:
            self._set_error(f"Failed to start: {e}")
            self._set_running(False)
            return False

    async def _run_polling(self) -> None:
        """
        Run the polling loop.

        This method runs the bot in a loop, automatically reconnecting
        on disconnection or errors.
        """
        retry_count = 0
        max_retries = 10
        base_delay = 1.0

        while self._is_running:
            try:
                logger.info(
                    "[Telegram] Channel %s (id=%d) starting polling...",
                    self.channel_name,
                    self.channel_id,
                )

                # Start polling
                await self._application.start()
                await self._application.updater.start_polling(
                    drop_pending_updates=True,
                    allowed_updates=Update.ALL_TYPES,
                )

                # Wait while running
                while self._is_running:
                    await asyncio.sleep(1)

            except asyncio.CancelledError:
                logger.info(
                    "[Telegram] Channel %s (id=%d) polling cancelled",
                    self.channel_name,
                    self.channel_id,
                )
                break

            except Exception as e:
                if not self._is_running:
                    break

                retry_count += 1
                if retry_count > max_retries:
                    self._set_error(f"Max retries ({max_retries}) exceeded")
                    self._set_running(False)
                    break

                # Exponential backoff with max 60 seconds
                delay = min(base_delay * (2 ** (retry_count - 1)), 60.0)
                logger.warning(
                    "[Telegram] Channel %s (id=%d) polling error (attempt %d/%d), "
                    "reconnecting in %.1fs: %s",
                    self.channel_name,
                    self.channel_id,
                    retry_count,
                    max_retries,
                    delay,
                    e,
                )
                await asyncio.sleep(delay)

            else:
                # Reset retry count on successful connection
                retry_count = 0

        logger.info(
            "[Telegram] Channel %s (id=%d) polling loop exited",
            self.channel_name,
            self.channel_id,
        )

    async def stop(self) -> None:
        """Stop the Telegram Bot."""
        if not self._is_running:
            logger.debug(
                "[Telegram] Channel %s (id=%d) is not running",
                self.channel_name,
                self.channel_id,
            )
            return

        logger.info(
            "[Telegram] Stopping channel %s (id=%d)...",
            self.channel_name,
            self.channel_id,
        )
        self._set_running(False)

        # Stop the application
        if self._application:
            try:
                if self._application.updater and self._application.updater.running:
                    await self._application.updater.stop()
                if self._application.running:
                    await self._application.stop()
                await self._application.shutdown()
            except Exception as e:
                logger.warning("[Telegram] Error stopping application: %s", e)

        # Cancel the background task
        if self._task and not self._task.done():
            self._task.cancel()
            try:
                await asyncio.wait_for(self._task, timeout=3.0)
            except (asyncio.CancelledError, asyncio.TimeoutError):
                pass

        self._task = None
        self._application = None
        self._bot = None
        self._handler = None

        logger.info(
            "[Telegram] Channel %s (id=%d) stopped",
            self.channel_name,
            self.channel_id,
        )

    def get_status(self) -> Dict[str, Any]:
        """
        Get the current status of the Telegram provider.

        Returns:
            Dictionary containing status information
        """
        status = super().get_status()
        status["extra_info"] = {
            "use_inline_keyboard": self.use_inline_keyboard,
            "default_team_id": self.default_team_id,
        }
        return status

    # ==================== Command Handlers ====================

    async def _handle_start_command(
        self, update: Update, context: ContextTypes.DEFAULT_TYPE
    ) -> None:
        """Handle /start command."""
        welcome_message = (
            "👋 欢迎使用 Wegent!\n\n"
            "我是你的 AI 助手，可以帮你完成各种任务。\n\n"
            "**快速开始:**\n"
            "• 直接发送消息与我对话\n"
            "• 使用 `/help` 查看所有命令\n"
            "• 使用 `/status` 查看当前状态"
        )
        await update.message.reply_text(welcome_message)

    async def _handle_help_command(
        self, update: Update, context: ContextTypes.DEFAULT_TYPE
    ) -> None:
        """Handle /help command."""
        from app.services.channels.commands import HELP_MESSAGE

        await update.message.reply_text(HELP_MESSAGE)

    async def _handle_new_command(
        self, update: Update, context: ContextTypes.DEFAULT_TYPE
    ) -> None:
        """Handle /new command."""
        if not self._handler:
            return

        message_context = self._handler.parse_message(update)

        db = SessionLocal()
        try:
            user = await self._handler.resolve_user(db, message_context)
            if not user:
                await update.message.reply_text("用户未注册，请先登录 Wegent 系统")
                return

            await self._handler._delete_conversation_task_id(
                message_context.conversation_id, user.id
            )
            await update.message.reply_text("✅ 已开始新对话，请发送您的消息")
        finally:
            db.close()

    async def _handle_status_command(
        self, update: Update, context: ContextTypes.DEFAULT_TYPE
    ) -> None:
        """Handle /status command."""
        if not self._handler:
            return

        message_context = self._handler.parse_message(update)

        db = SessionLocal()
        try:
            user = await self._handler.resolve_user(db, message_context)
            if not user:
                await update.message.reply_text("用户未注册，请先登录 Wegent 系统")
                return

            await self._handler._handle_status_command(db, user, message_context)
        finally:
            db.close()

    async def _handle_models_command(
        self, update: Update, context: ContextTypes.DEFAULT_TYPE
    ) -> None:
        """Handle /models command."""
        if not self._handler:
            return

        message_context = self._handler.parse_message(update)

        db = SessionLocal()
        try:
            user = await self._handler.resolve_user(db, message_context)
            if not user:
                await update.message.reply_text("用户未注册，请先登录 Wegent 系统")
                return

            # Check if there's an argument
            args = context.args
            if args:
                # Use the base handler's model command logic
                from app.services.channels.commands import ParsedCommand

                command = ParsedCommand(
                    command=CommandType.MODELS, argument=" ".join(args)
                )
                await self._handler._handle_command(db, user, command, message_context)
            else:
                # Show keyboard if enabled, otherwise use text list
                if self._handler._use_inline_keyboard:
                    await self._handler.send_models_keyboard(message_context, user)
                else:
                    command = ParsedCommand(command=CommandType.MODELS, argument=None)
                    await self._handler._handle_command(
                        db, user, command, message_context
                    )
        finally:
            db.close()

    async def _handle_devices_command(
        self, update: Update, context: ContextTypes.DEFAULT_TYPE
    ) -> None:
        """Handle /devices command."""
        if not self._handler:
            return

        message_context = self._handler.parse_message(update)

        db = SessionLocal()
        try:
            user = await self._handler.resolve_user(db, message_context)
            if not user:
                await update.message.reply_text("用户未注册，请先登录 Wegent 系统")
                return

            # Check if there's an argument
            args = context.args
            if args:
                # Use the base handler's devices command logic
                from app.services.channels.commands import ParsedCommand

                command = ParsedCommand(
                    command=CommandType.DEVICES, argument=" ".join(args)
                )
                await self._handler._handle_command(db, user, command, message_context)
            else:
                # Show keyboard if enabled, otherwise use text list
                if self._handler._use_inline_keyboard:
                    await self._handler.send_devices_keyboard(message_context, user)
                else:
                    command = ParsedCommand(command=CommandType.DEVICES, argument=None)
                    await self._handler._handle_command(
                        db, user, command, message_context
                    )
        finally:
            db.close()

    async def _handle_use_command(
        self, update: Update, context: ContextTypes.DEFAULT_TYPE
    ) -> None:
        """Handle /use command."""
        if not self._handler:
            return

        message_context = self._handler.parse_message(update)

        db = SessionLocal()
        try:
            user = await self._handler.resolve_user(db, message_context)
            if not user:
                await update.message.reply_text("用户未注册，请先登录 Wegent 系统")
                return

            # Check if there's an argument
            args = context.args
            if args:
                # Use the base handler's use command logic
                from app.services.channels.commands import ParsedCommand

                command = ParsedCommand(
                    command=CommandType.USE, argument=" ".join(args)
                )
                await self._handler._handle_command(db, user, command, message_context)
            else:
                # Show keyboard if enabled, otherwise show status
                if self._handler._use_inline_keyboard:
                    await self._handler.send_mode_keyboard(message_context, user)
                else:
                    await self._handler._handle_status_command(
                        db, user, message_context
                    )
        finally:
            db.close()

    async def _handle_callback_query(
        self, update: Update, context: ContextTypes.DEFAULT_TYPE
    ) -> None:
        """Handle inline keyboard callback queries."""
        if not self._handler:
            return

        message_context = self._handler.parse_message(update)

        db = SessionLocal()
        try:
            user = await self._handler.resolve_user(db, message_context)
            if not user:
                await update.callback_query.answer("用户未注册")
                return

            # Answer callback query to dismiss loading indicator
            await update.callback_query.answer()

            response = await self._handler.handle_callback_query(update, user)
            if response:
                # Edit the original message with the response
                try:
                    await update.callback_query.message.edit_text(response)
                except Exception:
                    # If edit fails, send new message
                    await update.callback_query.message.reply_text(response)
        finally:
            db.close()

    async def _handle_message(
        self, update: Update, context: ContextTypes.DEFAULT_TYPE
    ) -> None:
        """Handle regular text messages."""
        if not self._handler:
            return

        # Deduplicate messages
        msg_id = update.message.message_id if update.message else None
        chat_id = update.message.chat_id if update.message else None
        if msg_id and chat_id:
            dedup_key = f"{TELEGRAM_MSG_DEDUP_PREFIX}{chat_id}:{msg_id}"
            is_new = await cache_manager.setnx(
                dedup_key, "1", expire=TELEGRAM_MSG_DEDUP_TTL
            )
            if not is_new:
                logger.warning(
                    "[Telegram] Duplicate message detected, skipping: msg_id=%s",
                    msg_id,
                )
                return

        logger.info(
            "[Telegram] Received message: chat_id=%s, msg_id=%s, content_len=%s",
            chat_id,
            msg_id,
            len(update.message.text) if update.message and update.message.text else 0,
        )

        # Process through the channel handler
        await self._handler.handle_message(update)
