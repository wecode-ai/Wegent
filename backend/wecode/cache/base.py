# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Common cache utilities.

Provides:
- Constants (CACHE_TTL, NULL_MARKER)
- Redis client factory
- SQLAlchemy event registration helper
"""

import logging

logger = logging.getLogger(__name__)

# Cache configuration
CACHE_TTL = 300  # seconds
NULL_MARKER = "__NULL__"


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
