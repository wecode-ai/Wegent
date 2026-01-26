# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
IM Integration Manager.

Central manager for all IM integrations. Handles:
- Provider lifecycle management (start/stop)
- Message routing between IM platforms and Wegent
- Session management for conversation continuity
"""

import asyncio
import logging
from datetime import datetime, timezone
from typing import Any, Callable, Dict, Optional

from sqlalchemy.orm import Session

from app.core.config import settings
from app.db.session import SessionLocal
from app.models.kind import Kind
from app.models.task import TaskResource
from app.models.user import User
from app.schemas.task import TaskCreate
from app.services.im.base.message import (
    IMMessage,
    IMMessageType,
    IMOutboundMessage,
    IMPlatform,
)
from app.services.im.base.provider import IMProvider
from app.services.im.base.session import IMSession
from app.services.im.registry import IMProviderRegistry
from app.services.im.session_store import im_session_store

logger = logging.getLogger(__name__)


class IMIntegrationManager:
    """
    IM Integration Manager.

    Manages all active IM providers and handles message routing between
    IM platforms and the Wegent system.
    """

    def __init__(self):
        # Active providers: key = "{platform}:{team_id}"
        self._active_providers: Dict[str, IMProvider] = {}
        # Response callbacks: key = "{platform}:{team_id}:{chat_id}"
        self._response_callbacks: Dict[str, Callable] = {}
        self._lock = asyncio.Lock()

    def _get_provider_key(self, platform: IMPlatform, team_id: int) -> str:
        """Generate a unique key for a provider instance."""
        return f"{platform.value}:{team_id}"

    async def start_provider(
        self,
        team_id: int,
        platform: IMPlatform,
        config: dict,
    ) -> bool:
        """
        Start an IM provider for a team.

        Args:
            team_id: Wegent Team ID
            platform: IM platform
            config: Platform-specific configuration

        Returns:
            True if started successfully, False otherwise
        """
        key = self._get_provider_key(platform, team_id)

        async with self._lock:
            # Stop existing provider if any
            if key in self._active_providers:
                await self._stop_provider_internal(key)

            # Create new provider
            provider = IMProviderRegistry.create_provider(platform)
            if not provider:
                logger.error(f"Unknown platform: {platform}")
                return False

            # Initialize provider
            if not await provider.initialize(config):
                logger.error(f"Failed to initialize {platform} for team {team_id}")
                return False

            # Set message handler
            provider.set_message_handler(
                lambda msg: asyncio.create_task(
                    self._handle_message(msg, team_id)
                )
            )

            # Start provider
            try:
                await provider.start()
                self._active_providers[key] = provider
                logger.info(f"Started {platform} provider for team {team_id}")
                return True
            except Exception as e:
                logger.error(f"Failed to start {platform} provider: {e}")
                return False

    async def stop_provider(self, team_id: int, platform: IMPlatform) -> None:
        """
        Stop an IM provider for a team.

        Args:
            team_id: Wegent Team ID
            platform: IM platform
        """
        key = self._get_provider_key(platform, team_id)
        async with self._lock:
            await self._stop_provider_internal(key)

    async def _stop_provider_internal(self, key: str) -> None:
        """Internal method to stop a provider (must be called with lock held)."""
        provider = self._active_providers.pop(key, None)
        if provider:
            try:
                await provider.stop()
                logger.info(f"Stopped provider: {key}")
            except Exception as e:
                logger.error(f"Error stopping provider {key}: {e}")

    async def stop_all(self) -> None:
        """Stop all active providers."""
        async with self._lock:
            keys = list(self._active_providers.keys())
            for key in keys:
                await self._stop_provider_internal(key)
            logger.info("Stopped all IM providers")

    def is_provider_active(self, team_id: int, platform: IMPlatform) -> bool:
        """Check if a provider is active."""
        key = self._get_provider_key(platform, team_id)
        return key in self._active_providers

    async def _handle_message(self, message: IMMessage, team_id: int) -> None:
        """
        Handle an incoming message from an IM platform.

        Routes the message to the appropriate handler based on message type.
        """
        try:
            logger.info(
                f"Received message from {message.platform.value}: "
                f"user={message.user.platform_user_id}, type={message.message_type}"
            )

            # Handle commands
            if message.message_type == IMMessageType.COMMAND:
                await self._handle_command(message, team_id)
                return

            # Handle text messages
            await self._handle_text_message(message, team_id)

        except Exception as e:
            logger.error(f"Error handling message: {e}", exc_info=True)
            await self._send_error_message(
                message,
                team_id,
                "Sorry, an error occurred while processing your message.",
            )

    async def _handle_command(self, message: IMMessage, team_id: int) -> None:
        """Handle command messages."""
        command = message.command.lower() if message.command else ""

        if command == "start":
            await self._send_welcome_message(message, team_id)
        elif command == "new":
            await self._start_new_session(message, team_id)
        elif command == "help":
            await self._send_help_message(message, team_id)
        else:
            # Unknown command - treat as text message
            await self._handle_text_message(message, team_id)

    async def _handle_text_message(self, message: IMMessage, team_id: int) -> None:
        """Handle text messages - create or append to a task."""
        # Get or create session
        session = await im_session_store.get_or_create_session(
            platform=message.platform,
            platform_user_id=message.user.platform_user_id,
            platform_chat_id=message.chat_id,
            team_id=team_id,
            session_timeout_minutes=getattr(
                settings, "IM_SESSION_TIMEOUT_MINUTES", 60
            ),
        )

        # Send typing indicator
        await self._send_typing(message, team_id)

        # Create or append task
        try:
            task_result = await self._create_or_append_task(
                session=session,
                content=message.content,
                team_id=team_id,
                im_user=message.user,
            )

            # Update session with task ID
            if task_result:
                session.task_id = task_result.get("id")
                await im_session_store.update_session(session)

                # Wait for AI response and send it
                await self._wait_and_send_response(
                    message, team_id, session.task_id
                )

        except Exception as e:
            logger.error(f"Error creating task: {e}", exc_info=True)
            await self._send_error_message(
                message,
                team_id,
                f"Failed to process your message: {str(e)}",
            )

    async def _create_or_append_task(
        self,
        session: IMSession,
        content: str,
        team_id: int,
        im_user: Any,
    ) -> Optional[Dict]:
        """Create a new task or append to existing one."""
        from app.services.adapters.task_kinds import task_kinds_service

        db: Session = SessionLocal()
        try:
            # Get team to find owner
            team = (
                db.query(Kind)
                .filter(Kind.id == team_id, Kind.kind == "Team", Kind.is_active.is_(True))
                .first()
            )

            if not team:
                raise ValueError(f"Team {team_id} not found")

            # Get team owner as the user for task creation
            user = db.query(User).filter(User.id == team.user_id).first()
            if not user:
                raise ValueError(f"Team owner not found for team {team_id}")

            # Create task
            task_create = TaskCreate(
                team_id=team_id,
                prompt=content,
                type="online",
                task_type="chat",
                source="im",
            )

            result = task_kinds_service.create_task_or_append(
                db,
                obj_in=task_create,
                user=user,
                task_id=session.task_id,
            )

            return result

        finally:
            db.close()

    async def _wait_and_send_response(
        self,
        message: IMMessage,
        team_id: int,
        task_id: int,
    ) -> None:
        """Wait for AI response and send it to the IM platform."""
        from app.models.subtask import Subtask, SubtaskStatus

        max_wait_seconds = 300  # 5 minutes
        poll_interval = 1  # 1 second

        db: Session = SessionLocal()
        try:
            start_time = datetime.now(timezone.utc)
            last_response = None

            while (datetime.now(timezone.utc) - start_time).total_seconds() < max_wait_seconds:
                # Get the latest subtask for this task
                subtask = (
                    db.query(Subtask)
                    .filter(Subtask.task_id == task_id)
                    .order_by(Subtask.id.desc())
                    .first()
                )

                if subtask:
                    # Check if completed or failed
                    if subtask.status in [SubtaskStatus.COMPLETED, SubtaskStatus.FAILED]:
                        response = subtask.response or subtask.error_message or ""
                        if response and response != last_response:
                            await self.send_response(
                                message.platform,
                                team_id,
                                message.chat_id,
                                response,
                            )
                        return

                    # Send intermediate responses if available
                    if subtask.response and subtask.response != last_response:
                        last_response = subtask.response
                        # Don't send intermediate responses to avoid spam
                        # Only send final response

                await asyncio.sleep(poll_interval)
                db.expire_all()  # Refresh cached objects

            # Timeout - send timeout message
            await self._send_error_message(
                message,
                team_id,
                "Response timeout. Please try again.",
            )

        finally:
            db.close()

    async def send_response(
        self,
        platform: IMPlatform,
        team_id: int,
        chat_id: str,
        content: str,
    ) -> None:
        """
        Send a response message to an IM platform.

        Args:
            platform: Target IM platform
            team_id: Wegent Team ID
            chat_id: Platform-specific chat ID
            content: Message content (Markdown)
        """
        key = self._get_provider_key(platform, team_id)
        provider = self._active_providers.get(key)

        if not provider:
            logger.warning(f"No active provider for {key}")
            return

        message = IMOutboundMessage(content=content)
        try:
            await provider.send_message(chat_id, message)
        except Exception as e:
            logger.error(f"Failed to send response: {e}")

    async def _send_typing(self, message: IMMessage, team_id: int) -> None:
        """Send typing indicator."""
        key = self._get_provider_key(message.platform, team_id)
        provider = self._active_providers.get(key)
        if provider:
            try:
                await provider.send_typing_indicator(message.chat_id)
            except Exception as e:
                logger.debug(f"Failed to send typing indicator: {e}")

    async def _send_welcome_message(self, message: IMMessage, team_id: int) -> None:
        """Send welcome message."""
        welcome = (
            "Welcome! I'm your AI assistant.\n\n"
            "Commands:\n"
            "/new - Start a new conversation\n"
            "/help - Show this help message\n\n"
            "Just send me a message to start chatting!"
        )
        await self.send_response(message.platform, team_id, message.chat_id, welcome)

    async def _send_help_message(self, message: IMMessage, team_id: int) -> None:
        """Send help message."""
        help_text = (
            "Available commands:\n"
            "/start - Show welcome message\n"
            "/new - Start a new conversation\n"
            "/help - Show this help message\n\n"
            "Or just send me any message to chat!"
        )
        await self.send_response(message.platform, team_id, message.chat_id, help_text)

    async def _start_new_session(self, message: IMMessage, team_id: int) -> None:
        """Start a new conversation session."""
        # Delete existing session
        await im_session_store.delete_session(
            message.platform,
            message.user.platform_user_id,
            team_id,
        )

        await self.send_response(
            message.platform,
            team_id,
            message.chat_id,
            "New conversation started! Send me your message.",
        )

    async def _send_error_message(
        self,
        message: IMMessage,
        team_id: int,
        error: str,
    ) -> None:
        """Send error message."""
        await self.send_response(
            message.platform,
            team_id,
            message.chat_id,
            f"Error: {error}",
        )


# Global manager instance
im_manager = IMIntegrationManager()
