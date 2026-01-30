# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
DingTalk Stream Channel Provider.

This module provides the channel provider for DingTalk Stream mode integration.
It manages the DingTalk Stream client lifecycle and message handling.

IM channels are stored as Messager CRD in the kinds table.
"""

import asyncio
import logging
from typing import Any, Dict, Optional

import dingtalk_stream

from app.services.channels.base import BaseChannelProvider
from app.services.channels.dingtalk.handler import WegentChatbotHandler

logger = logging.getLogger(__name__)

# CRD kind for IM channels
MESSAGER_KIND = "Messager"
MESSAGER_USER_ID = 0


def _get_channel_default_team_id(channel_id: int) -> Optional[int]:
    """
    Get the current default_team_id for a channel from database.

    This function is used by the handler to dynamically get the latest
    default_team_id, allowing configuration updates without restart.
    IM channels are stored as Messager CRD in the kinds table.

    Args:
        channel_id: The IM channel ID (Kind.id)

    Returns:
        The default team ID or None
    """
    from app.db.session import SessionLocal
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

    This function is used by the handler to dynamically get the latest
    default_model_name, allowing configuration updates without restart.
    IM channels are stored as Messager CRD in the kinds table.

    Args:
        channel_id: The IM channel ID (Kind.id)

    Returns:
        The default model name or None (returns None if empty string)
    """
    from app.db.session import SessionLocal
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
            # Return None if empty string, otherwise return the model name
            return model_name if model_name else None
        return None
    finally:
        db.close()


class DingTalkChannelProvider(BaseChannelProvider):
    """
    DingTalk Stream channel provider.

    Manages the DingTalk Stream client lifecycle, including:
    - Starting and stopping the stream client
    - Reconnection logic with exponential backoff
    - Health monitoring
    """

    def __init__(self, channel: Any):
        """
        Initialize the DingTalk channel provider.

        Args:
            channel: Channel-like object (IMChannelAdapter) with DingTalk configuration
        """
        super().__init__(channel)
        self._client: Optional[dingtalk_stream.DingTalkStreamClient] = None
        self._task: Optional[asyncio.Task] = None

    @property
    def client_id(self) -> Optional[str]:
        """Get the DingTalk client ID from config."""
        return self.config.get("client_id")

    @property
    def client_secret(self) -> Optional[str]:
        """Get the DingTalk client secret from config."""
        return self.config.get("client_secret")

    @property
    def use_ai_card(self) -> bool:
        """Whether to use AI Card for streaming responses."""
        return self.config.get("use_ai_card", True)

    def _is_configured(self) -> bool:
        """Check if DingTalk is properly configured."""
        return bool(self.client_id and self.client_secret)

    async def start(self) -> bool:
        """
        Start the DingTalk Stream client.

        Returns:
            True if started successfully, False otherwise
        """
        if not self._is_configured():
            self._set_error(
                "DingTalk not configured: missing client_id or client_secret"
            )
            return False

        if self._is_running:
            logger.warning(
                "[DingTalk] Channel %s (id=%d) is already running",
                self.channel_name,
                self.channel_id,
            )
            return True

        try:
            logger.info(
                "[DingTalk] Starting channel %s (id=%d)...",
                self.channel_name,
                self.channel_id,
            )

            # Create credential
            credential = dingtalk_stream.Credential(
                self.client_id,
                self.client_secret,
            )

            # Create client
            self._client = dingtalk_stream.DingTalkStreamClient(credential)

            # Register chatbot handler with dynamic default_team_id getter
            # This reads from database to always get the latest default_team_id
            # even if the channel configuration is updated without restart
            channel_id = self.channel_id
            handler = WegentChatbotHandler(
                dingtalk_client=self._client,
                use_ai_card=self.use_ai_card,
                get_default_team_id=lambda: _get_channel_default_team_id(channel_id),
                get_default_model_name=lambda: _get_channel_default_model_name(
                    channel_id
                ),
            )
            self._client.register_callback_handler(
                dingtalk_stream.chatbot.ChatbotMessage.TOPIC,
                handler,
            )

            # Start client in background task
            self._task = asyncio.create_task(self._run_client())
            self._set_running(True)

            logger.info(
                "[DingTalk] Channel %s (id=%d) started successfully, client_id=%s...",
                self.channel_name,
                self.channel_id,
                self.client_id[:8] if self.client_id else "N/A",
            )
            return True

        except Exception as e:
            self._set_error(f"Failed to start: {e}")
            self._set_running(False)
            return False

    async def _run_client(self) -> None:
        """
        Run the stream client with automatic reconnection.

        This method runs the client in a loop, automatically reconnecting
        on disconnection or errors.
        """
        retry_count = 0
        max_retries = 10
        base_delay = 1.0

        while self._is_running:
            try:
                logger.info(
                    "[DingTalk] Channel %s (id=%d) starting connection...",
                    self.channel_name,
                    self.channel_id,
                )
                await self._client.start()

            except asyncio.CancelledError:
                logger.info(
                    "[DingTalk] Channel %s (id=%d) task cancelled",
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
                    "[DingTalk] Channel %s (id=%d) connection error (attempt %d/%d), "
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
            "[DingTalk] Channel %s (id=%d) client loop exited",
            self.channel_name,
            self.channel_id,
        )

    async def stop(self) -> None:
        """Stop the DingTalk Stream client."""
        if not self._is_running:
            logger.debug(
                "[DingTalk] Channel %s (id=%d) is not running",
                self.channel_name,
                self.channel_id,
            )
            return

        logger.info(
            "[DingTalk] Stopping channel %s (id=%d)...",
            self.channel_name,
            self.channel_id,
        )
        self._set_running(False)

        # Cancel the background task with timeout
        if self._task and not self._task.done():
            self._task.cancel()
            try:
                # Wait for task to finish with timeout
                await asyncio.wait_for(self._task, timeout=3.0)
            except asyncio.CancelledError:
                pass
            except asyncio.TimeoutError:
                logger.warning(
                    "[DingTalk] Channel %s (id=%d) stop timed out, force stopping",
                    self.channel_name,
                    self.channel_id,
                )

        self._task = None
        self._client = None

        logger.info(
            "[DingTalk] Channel %s (id=%d) stopped",
            self.channel_name,
            self.channel_id,
        )

    def get_status(self) -> Dict[str, Any]:
        """
        Get the current status of the DingTalk provider.

        Returns:
            Dictionary containing status information
        """
        status = super().get_status()
        status["extra_info"] = {
            "client_id": f"{self.client_id[:8]}..." if self.client_id else None,
            "use_ai_card": self.use_ai_card,
            "default_team_id": self.default_team_id,
        }
        return status
