# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Server-owned card addresses. Callback parameters never select a task."""

from typing import Any

from pydantic import BaseModel

from app.core.cache import cache_manager
from app.schemas.dingtalk_card import DingTalkChatCardConfig

CARD_BINDING_TTL = 7 * 24 * 60 * 60


class CardBinding(BaseModel):
    channel_id: int
    user_id: int
    task_id: int | str
    subtask_id: int
    incoming_data: dict[str, Any]
    config: DingTalkChatCardConfig
    runtime_task: dict[str, Any] | None = None
    ready: bool = False


def binding_key(channel_id: int, out_track_id: str) -> str:
    return f"dingtalk:chat_card:{channel_id}:{out_track_id}"


async def save_binding(out_track_id: str, binding: CardBinding) -> None:
    saved = await cache_manager.set(
        binding_key(binding.channel_id, out_track_id),
        binding.model_dump(),
        expire=CARD_BINDING_TTL,
    )
    if not saved:
        raise RuntimeError("Could not persist DingTalk card conversation binding")


async def load_binding(channel_id: int, out_track_id: str) -> CardBinding | None:
    data = await cache_manager.get(binding_key(channel_id, out_track_id))
    return CardBinding.model_validate(data) if data else None


async def mark_card_ready(channel_id: int, out_track_id: str) -> None:
    binding = await load_binding(channel_id, out_track_id)
    if binding:
        binding.ready = True
        await save_binding(out_track_id, binding)


def reply_address(data: dict[str, Any]) -> dict[str, Any]:
    """Keep delivery/identity fields; exclude text, downloads and webhook secrets."""
    names = (
        "senderId",
        "senderStaffId",
        "senderCorpId",
        "senderNick",
        "conversationId",
        "conversationType",
        "chatbotCorpId",
        "chatbotUserId",
    )
    return {name: data[name] for name in names if name in data}
