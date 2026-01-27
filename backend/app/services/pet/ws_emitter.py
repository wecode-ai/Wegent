# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Pet WebSocket emitter for Socket.IO events.

This module provides WebSocket event emission methods for pet-related events.
It wraps the global WebSocket emitter and provides typed methods for pet events.

This keeps pet-related WebSocket logic within the pet module for better cohesion.
"""

import logging
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)


async def emit_pet_experience_gained(
    user_id: int,
    amount: int,
    total: int,
    source: str,
    multiplier: float = 1.0,
) -> None:
    """
    Emit pet:experience_gained event to user room.

    Args:
        user_id: User ID
        amount: Amount of experience gained
        total: Total experience after gain
        source: Source of experience gain (chat, memory, streak_bonus)
        multiplier: Multiplier applied to the base experience
    """
    from app.api.ws.events import ServerEvents
    from app.services.chat.ws_emitter import get_ws_emitter

    ws_emitter = get_ws_emitter()
    if not ws_emitter:
        logger.warning("[PET_WS] WebSocket emitter not initialized, skipping emit")
        return

    await ws_emitter.sio.emit(
        ServerEvents.PET_EXPERIENCE_GAINED,
        {
            "amount": amount,
            "total": total,
            "source": source,
            "multiplier": multiplier,
        },
        room=f"user:{user_id}",
        namespace=ws_emitter.namespace,
    )
    logger.debug(
        f"[PET_WS] emit pet:experience_gained user={user_id} amount={amount} total={total} source={source}"
    )


async def emit_pet_stage_evolved(
    user_id: int,
    old_stage: int,
    new_stage: int,
    old_stage_name: str,
    new_stage_name: str,
) -> None:
    """
    Emit pet:stage_evolved event to user room.

    Args:
        user_id: User ID
        old_stage: Previous evolution stage
        new_stage: New evolution stage
        old_stage_name: Previous stage name
        new_stage_name: New stage name
    """
    from app.api.ws.events import ServerEvents
    from app.services.chat.ws_emitter import get_ws_emitter

    ws_emitter = get_ws_emitter()
    if not ws_emitter:
        logger.warning("[PET_WS] WebSocket emitter not initialized, skipping emit")
        return

    await ws_emitter.sio.emit(
        ServerEvents.PET_STAGE_EVOLVED,
        {
            "old_stage": old_stage,
            "new_stage": new_stage,
            "old_stage_name": old_stage_name,
            "new_stage_name": new_stage_name,
        },
        room=f"user:{user_id}",
        namespace=ws_emitter.namespace,
    )
    logger.info(
        f"[PET_WS] emit pet:stage_evolved user={user_id} {old_stage_name} -> {new_stage_name}"
    )


async def emit_pet_traits_updated(
    user_id: int,
    traits: Dict[str, Any],
) -> None:
    """
    Emit pet:traits_updated event to user room.

    Args:
        user_id: User ID
        traits: Updated appearance traits
    """
    from app.api.ws.events import ServerEvents
    from app.services.chat.ws_emitter import get_ws_emitter

    ws_emitter = get_ws_emitter()
    if not ws_emitter:
        logger.warning("[PET_WS] WebSocket emitter not initialized, skipping emit")
        return

    await ws_emitter.sio.emit(
        ServerEvents.PET_TRAITS_UPDATED,
        {
            "traits": traits,
        },
        room=f"user:{user_id}",
        namespace=ws_emitter.namespace,
    )
    logger.info(f"[PET_WS] emit pet:traits_updated user={user_id} traits={traits}")
