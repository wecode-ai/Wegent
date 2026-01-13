# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Common cache utilities.

Provides:
- Constants (CACHE_TTL, NULL_MARKER)
- Redis client factory
- SQLAlchemy event registration helper
- Model serialization/deserialization helpers
"""

import logging
from datetime import datetime
from typing import Any, Dict, Optional, Type, TypeVar

logger = logging.getLogger(__name__)

# Cache configuration
CACHE_TTL = 300  # seconds
NULL_MARKER = "__NULL__"
CACHE_VERSION = "v2"  # Increment when cache format changes

T = TypeVar("T")


def model_to_dict(obj: Any) -> Dict[str, Any]:
    """
    Convert SQLAlchemy model to dictionary using table columns.

    Automatically handles datetime serialization to ISO format.
    """
    data = {}
    for column in obj.__table__.columns:
        value = getattr(obj, column.name)
        # Handle datetime serialization
        if isinstance(value, datetime):
            value = value.isoformat()
        data[column.name] = value
    return data


def dict_to_model(data: Dict[str, Any], model_class: Type[T]) -> Optional[T]:
    """
    Convert dictionary to SQLAlchemy model instance.

    Automatically handles datetime deserialization from ISO format.
    """
    if not data:
        return None

    obj = model_class()
    for column in model_class.__table__.columns:
        if column.name in data:
            value = data[column.name]
            # Handle datetime deserialization
            if value is not None and hasattr(column.type, "python_type"):
                if column.type.python_type == datetime and isinstance(value, str):
                    value = datetime.fromisoformat(value)
            setattr(obj, column.name, value)
    return obj


def get_redis_client():
    """
    Get Redis client with connection test.

    Returns:
        Redis client if available, None otherwise.
    """
    try:
        import redis

        from app.core.config import settings

        client = redis.from_url(settings.REDIS_URL)
        client.ping()
        return client
    except ImportError:
        logger.info("Redis module not available")
        return None
    except Exception as e:
        logger.info(f"Redis not available: {e}")
        return None


def register_events(model_class, handler, service) -> None:
    """
    Register SQLAlchemy event listeners for cache invalidation.

    Args:
        model_class: SQLAlchemy model class
        handler: Function(operation, target, service) to handle changes
        service: The cached service instance
    """
    from sqlalchemy import event

    @event.listens_for(model_class, "after_insert")
    def on_insert(mapper, connection, target):
        handler("INSERT", target, service)

    @event.listens_for(model_class, "after_update")
    def on_update(mapper, connection, target):
        handler("UPDATE", target, service)

    @event.listens_for(model_class, "after_delete")
    def on_delete(mapper, connection, target):
        handler("DELETE", target, service)

    logger.info(f"{model_class.__name__} cache events registered")
