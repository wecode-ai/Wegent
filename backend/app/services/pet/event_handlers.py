# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Pet event handlers for processing pet-related events.

This module subscribes to internal events and handles pet experience updates.
It decouples pet logic from chat and memory modules, maintaining low coupling
between modules.

Event handlers:
- ChatCompletedEvent: Updates pet experience when chat is completed
- MemoryCreatedEvent: Updates pet appearance traits based on memory content
"""

import logging
from typing import List

from app.core.events import ChatCompletedEvent, MemoryCreatedEvent, get_event_bus
from app.db.session import SessionLocal
from app.schemas.pet import STAGE_NAMES
from app.services.pet.manager import pet_service

logger = logging.getLogger(__name__)


async def handle_chat_completed(event: ChatCompletedEvent) -> None:
    """Handle chat completed event to update pet experience.

    This handler:
    1. Calls PetService.add_chat_experience to update the pet's experience
    2. Emits WebSocket events to notify the frontend about experience gain
    3. If the pet evolved, emits a stage evolution event

    Args:
        event: ChatCompletedEvent with user_id
    """
    logger.info("[PET] handle_chat_completed called: user_id=%d", event.user_id)
    try:
        # Import pet WebSocket emitter from pet module
        from app.services.pet.ws_emitter import (
            emit_pet_experience_gained,
            emit_pet_stage_evolved,
        )

        db = SessionLocal()
        try:
            # Add chat experience
            pet, exp_gained, evolved = pet_service.add_chat_experience(
                db, event.user_id
            )

            # Get pet spec for current values
            spec = pet.json.get("spec", {})
            total_exp = spec.get("experience", 0)
            current_streak = spec.get("currentStreak", 0)
            multiplier = pet_service._get_streak_multiplier(current_streak)

            logger.info(
                "[PET] Experience gained from chat: user_id=%d, exp_gained=%d, total=%d, evolved=%s",
                event.user_id,
                exp_gained,
                total_exp,
                evolved,
            )

            # Emit experience gained event
            await emit_pet_experience_gained(
                user_id=event.user_id,
                amount=exp_gained,
                total=total_exp,
                source="chat",
                multiplier=multiplier,
            )

            # If evolved, emit stage evolution event
            if evolved:
                new_stage = spec.get("stage", 1)
                old_stage = new_stage - 1
                await emit_pet_stage_evolved(
                    user_id=event.user_id,
                    old_stage=old_stage,
                    new_stage=new_stage,
                    old_stage_name=STAGE_NAMES.get(old_stage, "unknown"),
                    new_stage_name=STAGE_NAMES.get(new_stage, "unknown"),
                )
        finally:
            db.close()

    except Exception as e:
        # Log error but don't fail - pet experience is non-critical
        logger.error(
            "[PET] Failed to update pet experience for chat: user_id=%d, error=%s",
            event.user_id,
            e,
            exc_info=True,
        )


async def handle_memory_created(event: MemoryCreatedEvent) -> None:
    """Handle memory created event to update pet appearance traits.

    This handler detects user domain from memory texts and updates pet appearance traits.
    Memory creation no longer grants experience points.

    Args:
        event: MemoryCreatedEvent with user_id, memory_count, and memory_texts
    """
    try:
        # Import pet WebSocket emitter from pet module
        from app.services.pet.ws_emitter import emit_pet_traits_updated

        db = SessionLocal()
        try:
            # Detect domain from memory texts and update appearance traits
            if event.memory_texts:
                updated_pet, domain_changed = pet_service.update_domain_from_memories(
                    db, event.user_id, event.memory_texts
                )
                if domain_changed and updated_pet:
                    updated_spec = updated_pet.json.get("spec", {})
                    updated_traits = updated_spec.get("appearanceTraits", {})
                    logger.info(
                        "[PET] Domain updated from memories: user_id=%d, new_traits=%s",
                        event.user_id,
                        updated_traits,
                    )

                    # Emit traits updated event
                    await emit_pet_traits_updated(
                        user_id=event.user_id,
                        traits=updated_traits,
                    )
        finally:
            db.close()

    except Exception as e:
        # Log error but don't fail - pet traits update is non-critical
        logger.error(
            "[PET] Failed to update pet traits for memory: user_id=%d, error=%s",
            event.user_id,
            e,
            exc_info=True,
        )


def register_pet_event_handlers() -> None:
    """Register all pet event handlers with the event bus.

    This function should be called during application startup to ensure
    pet event handlers are subscribed to the relevant events.
    """
    event_bus = get_event_bus()

    # Subscribe to chat completed events
    event_bus.subscribe(ChatCompletedEvent, handle_chat_completed)
    logger.info("[PET] Subscribed to ChatCompletedEvent")

    # Subscribe to memory created events
    event_bus.subscribe(MemoryCreatedEvent, handle_memory_created)
    logger.info("[PET] Subscribed to MemoryCreatedEvent")

    logger.info("[PET] Pet event handlers registered")
