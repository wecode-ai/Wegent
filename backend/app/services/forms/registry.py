# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Form handler registry.

Uses a decorator pattern to register form handlers for different action types.
"""

import logging
from typing import Dict, Type

from app.services.forms.base_handler import BaseFormHandler

logger = logging.getLogger(__name__)

# Registry of form handlers by action_type
_form_handlers: Dict[str, Type[BaseFormHandler]] = {}


def form_handler(action_type: str):
    """
    Decorator to register a form handler for a specific action_type.

    Usage:
        @form_handler("clarification")
        class ClarificationHandler(BaseFormHandler):
            ...

    Args:
        action_type: The action type string this handler processes

    Returns:
        Decorator function that registers the handler class
    """

    def decorator(cls: Type[BaseFormHandler]) -> Type[BaseFormHandler]:
        if action_type in _form_handlers:
            logger.warning(
                f"Overwriting existing handler for action_type '{action_type}'"
            )
        _form_handlers[action_type] = cls
        logger.debug(f"Registered form handler '{cls.__name__}' for '{action_type}'")
        return cls

    return decorator


def get_handler(action_type: str) -> Type[BaseFormHandler]:
    """
    Get the handler class for a given action_type.

    Args:
        action_type: The action type to look up

    Returns:
        The handler class registered for this action_type

    Raises:
        ValueError: If no handler is registered for the action_type
    """
    if action_type not in _form_handlers:
        available = ", ".join(_form_handlers.keys()) or "none"
        raise ValueError(
            f"Unknown action_type: '{action_type}'. Available handlers: {available}"
        )
    return _form_handlers[action_type]


def get_registered_action_types() -> list:
    """
    Get list of all registered action types.

    Returns:
        List of registered action type strings
    """
    return list(_form_handlers.keys())


def is_action_type_registered(action_type: str) -> bool:
    """
    Check if an action type has a registered handler.

    Args:
        action_type: The action type to check

    Returns:
        True if a handler is registered, False otherwise
    """
    return action_type in _form_handlers
