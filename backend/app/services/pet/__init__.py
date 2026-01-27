# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Pet service package."""

from app.services.pet.event_handlers import register_pet_event_handlers
from app.services.pet.manager import pet_service

__all__ = ["pet_service", "register_pet_event_handlers"]
