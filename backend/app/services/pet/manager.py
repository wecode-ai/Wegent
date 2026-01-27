# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Pet service manager for handling pet business logic."""

import secrets
from datetime import date, datetime, timedelta
from typing import Any, Dict, Optional, Tuple

from sqlalchemy.orm import Session

from app.models.pet import UserPet
from app.schemas.pet import (
    DOMAIN_APPEARANCE_MAP,
    STAGE_NAMES,
    PetCreate,
    PetResponse,
    PetUpdate,
)


class PetService:
    """Service class for pet operations."""

    # Experience gain amounts
    EXP_PER_CHAT = 1
    EXP_PER_MEMORY = 5

    # Stage thresholds
    STAGE_THRESHOLDS = {
        1: 0,      # Baby: 0-99
        2: 100,    # Growing: 100-499
        3: 500,    # Mature: 500+
    }

    def _generate_svg_seed(self) -> str:
        """Generate a random SVG seed for consistent pet appearance."""
        return secrets.token_hex(32)

    def _calculate_stage(self, experience: int) -> int:
        """Calculate the evolution stage based on experience."""
        if experience >= self.STAGE_THRESHOLDS[3]:
            return 3
        elif experience >= self.STAGE_THRESHOLDS[2]:
            return 2
        return 1

    def _get_experience_to_next_stage(self, experience: int, stage: int) -> Optional[int]:
        """Calculate experience needed for next stage."""
        if stage >= 3:
            return None  # Already at max stage
        next_threshold = self.STAGE_THRESHOLDS.get(stage + 1, None)
        if next_threshold is None:
            return None
        return max(0, next_threshold - experience)

    def _get_streak_multiplier(self, current_streak: int) -> float:
        """Get the experience multiplier based on current streak."""
        if current_streak >= 30:
            return 1.5
        elif current_streak >= 7:
            return 1.2
        elif current_streak >= 3:
            return 1.1
        return 1.0

    def _update_streak(self, pet: UserPet, today: date) -> Tuple[int, bool]:
        """
        Update the streak based on last active date.

        Returns:
            Tuple of (new_streak, is_new_day)
        """
        if pet.last_active_date is None:
            # First activity
            return 1, True

        days_diff = (today - pet.last_active_date).days

        if days_diff == 0:
            # Same day, no change
            return pet.current_streak, False
        elif days_diff == 1:
            # Consecutive day
            return pet.current_streak + 1, True
        else:
            # Streak broken
            return 1, True

    def get_pet(self, db: Session, user_id: int) -> Optional[UserPet]:
        """Get a user's pet."""
        return db.query(UserPet).filter(UserPet.user_id == user_id).first()

    def get_or_create_pet(self, db: Session, user_id: int) -> UserPet:
        """Get existing pet or create a new one for the user."""
        pet = self.get_pet(db, user_id)
        if pet is None:
            pet = self.create_pet(db, user_id)
        return pet

    def create_pet(self, db: Session, user_id: int, pet_name: str = "Buddy") -> UserPet:
        """Create a new pet for a user."""
        pet = UserPet(
            user_id=user_id,
            pet_name=pet_name,
            stage=1,
            experience=0,
            total_chats=0,
            total_memories=0,
            current_streak=0,
            longest_streak=0,
            last_active_date=None,
            appearance_traits={
                "primary_domain": "general",
                "secondary_domain": None,
                "color_tone": "teal",
                "accessories": [],
            },
            svg_seed=self._generate_svg_seed(),
            is_visible=True,
        )
        db.add(pet)
        db.commit()
        db.refresh(pet)
        return pet

    def update_pet(
        self, db: Session, user_id: int, pet_update: PetUpdate
    ) -> Optional[UserPet]:
        """Update a user's pet settings."""
        pet = self.get_pet(db, user_id)
        if pet is None:
            return None

        update_data = pet_update.model_dump(exclude_unset=True)
        for field, value in update_data.items():
            setattr(pet, field, value)

        db.commit()
        db.refresh(pet)
        return pet

    def reset_pet(self, db: Session, user_id: int) -> UserPet:
        """Reset a user's pet to initial state with new seed."""
        pet = self.get_pet(db, user_id)
        if pet is None:
            return self.create_pet(db, user_id)

        # Reset all stats but keep visibility preference
        pet.stage = 1
        pet.experience = 0
        pet.total_chats = 0
        pet.total_memories = 0
        pet.current_streak = 0
        pet.longest_streak = 0
        pet.last_active_date = None
        pet.appearance_traits = {
            "primary_domain": "general",
            "secondary_domain": None,
            "color_tone": "teal",
            "accessories": [],
        }
        pet.svg_seed = self._generate_svg_seed()

        db.commit()
        db.refresh(pet)
        return pet

    def add_chat_experience(
        self, db: Session, user_id: int
    ) -> Tuple[UserPet, int, bool]:
        """
        Add experience for sending a chat message.

        Returns:
            Tuple of (pet, exp_gained, evolved)
        """
        pet = self.get_or_create_pet(db, user_id)
        today = date.today()

        # Update streak
        new_streak, is_new_day = self._update_streak(pet, today)
        if is_new_day:
            pet.current_streak = new_streak
            pet.last_active_date = today
            if new_streak > pet.longest_streak:
                pet.longest_streak = new_streak

        # Calculate experience with multiplier
        multiplier = self._get_streak_multiplier(pet.current_streak)
        exp_gained = int(self.EXP_PER_CHAT * multiplier)

        # Update stats
        pet.total_chats += 1
        old_stage = pet.stage
        pet.experience += exp_gained
        pet.stage = self._calculate_stage(pet.experience)
        evolved = pet.stage > old_stage

        db.commit()
        db.refresh(pet)
        return pet, exp_gained, evolved

    def add_memory_experience(
        self, db: Session, user_id: int
    ) -> Tuple[UserPet, int, bool]:
        """
        Add experience for creating a long-term memory.

        Returns:
            Tuple of (pet, exp_gained, evolved)
        """
        pet = self.get_or_create_pet(db, user_id)
        today = date.today()

        # Update streak
        new_streak, is_new_day = self._update_streak(pet, today)
        if is_new_day:
            pet.current_streak = new_streak
            pet.last_active_date = today
            if new_streak > pet.longest_streak:
                pet.longest_streak = new_streak

        # Calculate experience with multiplier
        multiplier = self._get_streak_multiplier(pet.current_streak)
        exp_gained = int(self.EXP_PER_MEMORY * multiplier)

        # Update stats
        pet.total_memories += 1
        old_stage = pet.stage
        pet.experience += exp_gained
        pet.stage = self._calculate_stage(pet.experience)
        evolved = pet.stage > old_stage

        db.commit()
        db.refresh(pet)
        return pet, exp_gained, evolved

    def update_appearance_traits(
        self, db: Session, user_id: int, traits: Dict[str, Any]
    ) -> Optional[UserPet]:
        """Update a pet's appearance traits based on memory analysis."""
        pet = self.get_pet(db, user_id)
        if pet is None:
            return None

        # Merge with existing traits
        current_traits = dict(pet.appearance_traits) if pet.appearance_traits else {}
        current_traits.update(traits)

        # Apply domain-specific appearance if primary_domain changed
        primary_domain = current_traits.get("primary_domain", "general")
        if primary_domain in DOMAIN_APPEARANCE_MAP:
            domain_appearance = DOMAIN_APPEARANCE_MAP[primary_domain]
            current_traits["color_tone"] = domain_appearance["color_tone"]
            current_traits["accessories"] = domain_appearance["accessories"]

        pet.appearance_traits = current_traits
        db.commit()
        db.refresh(pet)
        return pet

    def to_response(self, pet: UserPet) -> PetResponse:
        """Convert a UserPet model to a PetResponse schema."""
        return PetResponse(
            id=pet.id,
            user_id=pet.user_id,
            pet_name=pet.pet_name,
            stage=pet.stage,
            experience=pet.experience,
            total_chats=pet.total_chats,
            total_memories=pet.total_memories,
            current_streak=pet.current_streak,
            longest_streak=pet.longest_streak,
            last_active_date=pet.last_active_date,
            appearance_traits=dict(pet.appearance_traits) if pet.appearance_traits else {},
            svg_seed=pet.svg_seed,
            is_visible=pet.is_visible,
            experience_to_next_stage=self._get_experience_to_next_stage(
                pet.experience, pet.stage
            ),
            streak_multiplier=self._get_streak_multiplier(pet.current_streak),
            created_at=pet.created_at,
            updated_at=pet.updated_at,
        )


# Global service instance
pet_service = PetService()
