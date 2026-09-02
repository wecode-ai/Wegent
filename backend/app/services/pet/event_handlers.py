# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Pet event handlers for processing pet-related events.

This module subscribes to internal events and handles pet experience updates.
It decouples pet logic from chat and memory modules, maintaining low coupling
between modules.

Event handlers:
- TaskCompletedEvent: Updates pet experience when task is completed successfully
- MemoryCreatedEvent: Updates pet appearance traits based on memory content
"""

import logging
from dataclasses import dataclass
from typing import Any, List

from app.core.events import MemoryCreatedEvent, TaskCompletedEvent
from app.db.session import SessionLocal
from app.schemas.pet import STAGE_NAMES
from app.services.chat.storage.db import run_sync_in_executor
from app.services.pet.manager import pet_service

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class _PetExperienceUpdate:
    amount: int
    total: int
    multiplier: float
    evolved: bool
    new_stage: int


@dataclass(frozen=True)
class _PetTraitsUpdate:
    traits: dict[str, Any]


def _add_task_completion_experience_sync(user_id: int) -> _PetExperienceUpdate:
    """Persist pet experience inside a database worker thread."""
    db = SessionLocal()
    try:
        pet, exp_gained, evolved = pet_service.add_chat_experience(db, user_id)
        spec = pet.json.get("spec", {})
        current_streak = spec.get("currentStreak", 0)
        return _PetExperienceUpdate(
            amount=exp_gained,
            total=spec.get("experience", 0),
            multiplier=pet_service._get_streak_multiplier(current_streak),
            evolved=evolved,
            new_stage=spec.get("stage", 1),
        )
    finally:
        db.close()


def _update_domain_from_memories_sync(
    user_id: int,
    memory_texts: List[str],
) -> _PetTraitsUpdate | None:
    """Persist and detach a pet domain update in the database worker."""
    db = SessionLocal()
    try:
        updated_pet, domain_changed = pet_service.update_domain_from_memories(
            db,
            user_id,
            memory_texts,
        )
        if not domain_changed or not updated_pet:
            return None
        updated_spec = updated_pet.json.get("spec", {})
        return _PetTraitsUpdate(
            traits=dict(updated_spec.get("appearanceTraits", {})),
        )
    finally:
        db.close()


async def handle_task_completed_for_pet(event: TaskCompletedEvent) -> None:
    """Handle task completed event to update pet experience.

    This handler:
    1. Only processes COMPLETED status (not FAILED or CANCELLED)
    2. Calls PetService.add_chat_experience to update the pet's experience
    3. Emits WebSocket events to notify the frontend about experience gain
    4. If the pet evolved, emits a stage evolution event

    Args:
        event: TaskCompletedEvent with user_id, status, etc.
    """
    # Only update pet experience for successfully completed tasks
    if event.status != "COMPLETED":
        return

    logger.info(
        "[PET] handle_task_completed_for_pet called: user_id=%d, task_id=%d",
        event.user_id,
        event.task_id,
    )
    try:
        # Use ExtendedEventEmitter for pet events
        from app.services.chat.webpage_ws_extended_emitter import (
            get_extended_emitter,
        )

        extended_emitter = get_extended_emitter()

        update = await run_sync_in_executor(
            _add_task_completion_experience_sync,
            event.user_id,
        )
        logger.info(
            "[PET] Experience gained from chat: user_id=%d, exp_gained=%d, total=%d, evolved=%s",
            event.user_id,
            update.amount,
            update.total,
            update.evolved,
        )

        await extended_emitter.emit_pet_experience_gained(
            user_id=event.user_id,
            amount=update.amount,
            total=update.total,
            source="chat",
            multiplier=update.multiplier,
        )

        if update.evolved:
            old_stage = update.new_stage - 1
            await extended_emitter.emit_pet_stage_evolved(
                user_id=event.user_id,
                old_stage=old_stage,
                new_stage=update.new_stage,
                old_stage_name=STAGE_NAMES.get(old_stage, "unknown"),
                new_stage_name=STAGE_NAMES.get(update.new_stage, "unknown"),
            )

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
        # Use ExtendedEventEmitter for pet events
        from app.services.chat.webpage_ws_extended_emitter import (
            get_extended_emitter,
        )

        if not event.memory_texts:
            return
        update = await run_sync_in_executor(
            _update_domain_from_memories_sync,
            event.user_id,
            event.memory_texts,
        )
        if update is None:
            return
        logger.info(
            "[PET] Domain updated from memories: user_id=%d, new_traits=%s",
            event.user_id,
            update.traits,
        )
        await get_extended_emitter().emit_pet_traits_updated(
            user_id=event.user_id,
            traits=update.traits,
        )

    except Exception as e:
        # Log error but don't fail - pet traits update is non-critical
        logger.error(
            "[PET] Failed to update pet traits for memory: user_id=%d, error=%s",
            event.user_id,
            e,
            exc_info=True,
        )
