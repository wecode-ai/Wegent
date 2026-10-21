"""Bounded, process-owned connections for plugin coordination infrastructure."""

import threading
from contextlib import ExitStack
from weakref import WeakKeyDictionary

from redis import Redis
from redis.backoff import NoBackoff
from redis.retry import Retry
from sqlalchemy import create_engine
from sqlalchemy.engine import Engine
from sqlalchemy.pool import Pool

from app.core.config import settings
from app.db.pool_observability import ObservedQueuePool, register_pool
from app.db.timezone import MYSQL_SESSION_TIMEZONE_OFFSET

_mutex = threading.Lock()
_redis: Redis | None = None
_policy_engines: WeakKeyDictionary[Pool, Engine] = WeakKeyDictionary()


def redis_client() -> Redis:
    """Bound each command rather than relying on Lock's contention timeout."""
    global _redis
    with _mutex:
        if _redis is None:
            _redis = Redis.from_url(
                settings.REDIS_URL,
                socket_timeout=0.5,
                socket_connect_timeout=0.5,
                retry=Retry(NoBackoff(), 0),
                retry_on_timeout=False,
            )
        return _redis


def policy_engine(business_engine: Engine) -> Engine:
    """Bound the first-use creation of the existing default auth policy."""
    if business_engine.dialect.name != "mysql":
        return business_engine
    with _mutex:
        engine = _policy_engines.get(business_engine.pool)
        if engine is None:
            engine = create_engine(
                business_engine.url,
                poolclass=ObservedQueuePool,
                pool_size=2,
                max_overflow=2,
                pool_timeout=1,
                pool_recycle=600,
                connect_args={
                    "charset": "utf8mb4",
                    "connect_timeout": 1,
                    "read_timeout": 4,
                    "write_timeout": 4,
                    "init_command": (
                        f"SET SESSION time_zone = '{MYSQL_SESSION_TIMEZONE_OFFSET}', "
                        "SESSION innodb_lock_wait_timeout = 3"
                    ),
                },
            )
            register_pool(
                engine.pool,
                engine_role="plugin_policy",
                pool_size=2,
                max_overflow=2,
                pool_timeout=1,
                pool_recycle=600,
            )
            _policy_engines[business_engine.pool] = engine
        return engine


def close_plugin_write_resources() -> None:
    global _redis
    with _mutex:
        client, _redis = _redis, None
        engines = list(_policy_engines.values())
        _policy_engines.clear()
    with ExitStack() as cleanup:
        for engine in engines:
            cleanup.callback(engine.dispose)
        if client is not None:
            cleanup.callback(client.close)
