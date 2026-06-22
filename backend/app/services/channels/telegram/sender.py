# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Telegram Bot Message Sender.

This module provides functionality to proactively send messages to users
via Telegram Bot API. Used for subscription notifications and other
push scenarios where there's no incoming message to reply to.

API Reference:
- Send message: POST /bot{token}/sendMessage
"""

import asyncio
import logging
from typing import Any, Dict, Optional

import httpx

logger = logging.getLogger(__name__)

TELEGRAM_SEND_MAX_ATTEMPTS = 3
TELEGRAM_SEND_RETRY_DELAY_SECONDS = 0.5


class TelegramBotSender:
    """Sender for proactively sending Telegram bot messages.

    This class uses Telegram's Bot API to send messages to users
    without requiring an incoming message context.
    """

    BASE_URL = "https://api.telegram.org"

    def __init__(self, bot_token: str):
        """Initialize the sender.

        Args:
            bot_token: Telegram bot token
        """
        self.bot_token = bot_token

    async def send_text_message(
        self,
        chat_id: int,
        text: str,
        parse_mode: Optional[str] = None,
        disable_notification: bool = False,
    ) -> Dict[str, Any]:
        """Send text message to a chat.

        Args:
            chat_id: Telegram chat ID
            text: Message text content
            parse_mode: Parse mode (Markdown, MarkdownV2, HTML)
            disable_notification: Send silently

        Returns:
            API response dict with success status
        """
        return await self._send_message(
            chat_id=chat_id,
            text=text,
            parse_mode=parse_mode,
            disable_notification=disable_notification,
        )

    async def send_markdown_message(
        self,
        chat_id: int,
        text: str,
        disable_notification: bool = False,
    ) -> Dict[str, Any]:
        """Send markdown message to a chat.

        Args:
            chat_id: Telegram chat ID
            text: Markdown text content
            disable_notification: Send silently

        Returns:
            API response dict with success status
        """
        # Use Markdown parse mode for better compatibility
        # MarkdownV2 requires escaping special characters
        return await self._send_message(
            chat_id=chat_id,
            text=text,
            parse_mode="Markdown",
            disable_notification=disable_notification,
        )

    async def _send_message(
        self,
        chat_id: int,
        text: str,
        parse_mode: Optional[str] = None,
        disable_notification: bool = False,
    ) -> Dict[str, Any]:
        """Send message to a chat via Telegram Bot API.

        Args:
            chat_id: Telegram chat ID
            text: Message text
            parse_mode: Parse mode (Markdown, MarkdownV2, HTML)
            disable_notification: Send silently

        Returns:
            API response dict
        """
        if not chat_id:
            return {"success": False, "error": "No chat ID provided"}

        last_error: dict[str, Any] | None = None
        for attempt in range(1, TELEGRAM_SEND_MAX_ATTEMPTS + 1):
            result = await self._send_message_once(
                chat_id=chat_id,
                text=text,
                parse_mode=parse_mode,
                disable_notification=disable_notification,
                attempt=attempt,
            )
            if result.get("success"):
                return result

            last_error = result
            if not result.get("retryable") or attempt >= TELEGRAM_SEND_MAX_ATTEMPTS:
                return result

            await asyncio.sleep(TELEGRAM_SEND_RETRY_DELAY_SECONDS * attempt)

        return last_error or {"success": False, "error": "Unknown Telegram send error"}

    async def _send_message_once(
        self,
        chat_id: int,
        text: str,
        parse_mode: Optional[str],
        disable_notification: bool,
        attempt: int,
    ) -> Dict[str, Any]:
        """Send one Telegram message attempt."""

        try:
            url = f"{self.BASE_URL}/bot{self.bot_token}/sendMessage"
            payload: Dict[str, Any] = {
                "chat_id": chat_id,
                "text": text,
            }

            if parse_mode:
                payload["parse_mode"] = parse_mode

            if disable_notification:
                payload["disable_notification"] = True

            logger.info(
                f"[TelegramSender] Sending message to chat_id={chat_id}, "
                f"text_length={len(text)}, attempt={attempt}"
            )

            async with httpx.AsyncClient(timeout=30.0) as client:
                response = await client.post(
                    url,
                    json=payload,
                    headers={"Content-Type": "application/json"},
                )
                response.raise_for_status()
                data = response.json()

                if data.get("ok"):
                    message_id = data.get("result", {}).get("message_id")
                    logger.info(
                        f"[TelegramSender] Message sent successfully, "
                        f"message_id={message_id}"
                    )
                    return {"success": True, "result": data}
                else:
                    error_desc = data.get("description", "Unknown error")
                    logger.error(f"[TelegramSender] API error: {error_desc}")
                    return {"success": False, "error": error_desc}

        except httpx.HTTPStatusError as e:
            error_data = {}
            try:
                error_data = e.response.json()
            except Exception:
                pass

            error_desc = error_data.get("description", str(e))
            logger.error(
                "[TelegramSender] HTTP error sending message: "
                "status_code=%s error=%s",
                e.response.status_code,
                error_desc,
            )

            return {
                "success": False,
                "error": error_desc,
                "error_type": e.__class__.__name__,
                "retryable": 500 <= e.response.status_code < 600,
            }

        except (httpx.TimeoutException, httpx.TransportError) as e:
            error_desc = str(e) or repr(e)
            logger.warning(
                "[TelegramSender] Retryable error sending message: "
                "type=%s attempt=%s/%s error=%s",
                e.__class__.__name__,
                attempt,
                TELEGRAM_SEND_MAX_ATTEMPTS,
                error_desc,
            )
            return {
                "success": False,
                "error": error_desc,
                "error_type": e.__class__.__name__,
                "retryable": True,
            }
        except Exception as e:
            error_desc = str(e) or repr(e)
            logger.exception(
                "[TelegramSender] Error sending message: type=%s error=%s",
                e.__class__.__name__,
                error_desc,
            )
            return {
                "success": False,
                "error": error_desc,
                "error_type": e.__class__.__name__,
            }
