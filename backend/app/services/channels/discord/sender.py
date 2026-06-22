# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Discord Bot message sender."""

import logging
from typing import Any, Dict

import httpx

logger = logging.getLogger(__name__)

DISCORD_MESSAGE_CONTENT_LIMIT = 2000
TRUNCATION_SUFFIX = "..."


class DiscordBotSender:
    """Sender for proactively sending Discord bot DMs."""

    BASE_URL = "https://discord.com/api/v10"

    def __init__(self, bot_token: str):
        self.bot_token = bot_token

    async def send_text_message(self, user_id: str, text: str) -> Dict[str, Any]:
        if not user_id:
            return {"success": False, "error": "No Discord user ID provided"}
        if not text:
            return {"success": False, "error": "No message text provided"}

        headers = {
            "Authorization": f"Bot {self.bot_token}",
            "Content-Type": "application/json",
        }
        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                dm_response = await client.post(
                    f"{self.BASE_URL}/users/@me/channels",
                    json={"recipient_id": str(user_id)},
                    headers=headers,
                )
                dm_response.raise_for_status()
                dm_channel_id = dm_response.json().get("id")
                if not dm_channel_id:
                    return {
                        "success": False,
                        "error": "Discord DM channel not returned",
                    }

                message_response = await client.post(
                    f"{self.BASE_URL}/channels/{dm_channel_id}/messages",
                    json={"content": _normalize_message_content(text)},
                    headers=headers,
                )
                message_response.raise_for_status()
                return {"success": True, "result": message_response.json()}
        except Exception as exc:
            logger.error("[DiscordSender] Error sending message: %s", exc)
            return {"success": False, "error": str(exc)}


def _normalize_message_content(text: str) -> str:
    if len(text) <= DISCORD_MESSAGE_CONTENT_LIMIT:
        return text

    truncated_length = DISCORD_MESSAGE_CONTENT_LIMIT - len(TRUNCATION_SUFFIX)
    return f"{text[:truncated_length]}{TRUNCATION_SUFFIX}"
