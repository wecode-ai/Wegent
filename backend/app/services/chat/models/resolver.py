# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Model resolver proxy for LangGraph Chat Service.

This module re-exports model resolution functions from the main chat service.
For direct usage, import from app.services.chat.model_resolver.

Exported functions:
- get_model_config_for_bot: Get fully processed model config for a Bot
- get_bot_system_prompt: Get system prompt for a Bot
- find_model: Find a model by name
"""

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from typing import Any

    from sqlalchemy.orm import Session

    from app.models.kind import Kind


def _lazy_import():
    """Lazy import to avoid circular dependencies."""
    from app.services.chat.model_resolver import (
        _extract_model_config,
        _find_model,
        _process_model_config_placeholders,
        get_bot_system_prompt,
    )

    return {
        "extract_model_config": _extract_model_config,
        "find_model": _find_model,
        "process_model_config_placeholders": _process_model_config_placeholders,
        "get_bot_system_prompt": get_bot_system_prompt,
    }


class ModelResolver:
    """Proxy class for model resolution functions.

    Provides a namespace for model resolution operations.
    All methods delegate to app.services.chat.model_resolver.
    """

    @staticmethod
    def get_system_prompt_for_bot(
        db: "Session",
        bot: "Kind",
        user_id: int,
        team_member_prompt: str | None = None,
    ) -> str:
        """Get the system prompt for a Bot (delegates to chat service)."""
        funcs = _lazy_import()
        return funcs["get_bot_system_prompt"](db, bot, user_id, team_member_prompt)

    @staticmethod
    def find_model_by_name(
        db: "Session",
        model_name: str,
        user_id: int,
    ) -> "dict[str, Any] | None":
        """Find a model by name (delegates to chat service)."""
        funcs = _lazy_import()
        return funcs["find_model"](db, model_name, user_id)


# For direct function access (alternative to class methods)
def get_bot_system_prompt(
    db: "Session",
    bot: "Kind",
    user_id: int,
    team_member_prompt: str | None = None,
) -> str:
    """Get the system prompt for a Bot."""
    funcs = _lazy_import()
    return funcs["get_bot_system_prompt"](db, bot, user_id, team_member_prompt)


def find_model(
    db: "Session",
    model_name: str,
    user_id: int,
) -> "dict[str, Any] | None":
    """Find a model by name."""
    funcs = _lazy_import()
    return funcs["find_model"](db, model_name, user_id)
