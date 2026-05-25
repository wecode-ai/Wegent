"""Redis-based distributed lock with watchdog extension.

Provides a context manager that acquires a Redis lock and periodically
extends its TTL via a background thread (watchdog pattern). This prevents
long-running conversion tasks from losing their lock prematurely.
"""

import logging
import threading
import time
from typing import Optional

import redis

from knowledge_doc_converter.config import settings

logger = logging.getLogger(__name__)


class DistributedLock:
    """Redis-based distributed lock with watchdog extension."""

    LOCK_PREFIX = "wegent:lock:"

    def __init__(self):
        self._redis: Optional[redis.Redis] = None

    @property
    def redis_client(self) -> redis.Redis:
        """Lazy-initialize Redis client."""
        if self._redis is None:
            self._redis = redis.from_url(settings.REDIS_URL)
        return self._redis

    def _prefixed(self, name: str) -> str:
        return f"{self.LOCK_PREFIX}{name}"

    def acquire(self, name: str, expire_seconds: int = 60) -> bool:
        """Acquire lock. Returns True if acquired, False if already held."""
        key = self._prefixed(name)
        return bool(self.redis_client.set(key, "1", nx=True, ex=expire_seconds))

    def release(self, name: str) -> None:
        """Release lock."""
        key = self._prefixed(name)
        self.redis_client.delete(key)

    def extend(self, name: str, expire_seconds: int) -> None:
        """Extend lock TTL."""
        key = self._prefixed(name)
        self.redis_client.expire(key, expire_seconds)

    class _WatchdogContext:
        """Context manager that keeps a lock alive via a background thread."""

        def __init__(
            self,
            lock: "DistributedLock",
            name: str,
            expire_seconds: int,
            extend_interval: int,
        ):
            self.lock = lock
            self.name = name
            self.expire_seconds = expire_seconds
            self.extend_interval = extend_interval
            self.acquired = False
            self._stop_event = threading.Event()
            self._thread: Optional[threading.Thread] = None

        def __enter__(self):
            self.acquired = self.lock.acquire(self.name, self.expire_seconds)
            if self.acquired:
                self._thread = threading.Thread(target=self._watchdog, daemon=True)
                self._thread.start()
            return self.acquired

        def __exit__(self, *args):
            self._stop_event.set()
            if self._thread:
                self._thread.join(timeout=5)
            if self.acquired:
                self.lock.release(self.name)

        def _watchdog(self):
            """Background thread that extends lock TTL periodically."""
            while not self._stop_event.wait(self.extend_interval):
                try:
                    self.lock.extend(self.name, self.expire_seconds)
                except Exception as e:
                    logger.error(f"Lock extend failed for {self.name}: {e}")

    def acquire_watchdog_context(
        self, name: str, expire_seconds: int, extend_interval_seconds: int
    ):
        """Context manager that acquires a lock and extends it periodically.

        Usage:
            with lock_service.acquire_watchdog_context("my-lock", 120, 30) as acquired:
                if not acquired:
                    # lock held by another worker
                    return
                # do work while lock is held and auto-extended
        """
        return self._WatchdogContext(
            self, name, expire_seconds, extend_interval_seconds
        )


lock_service = DistributedLock()
