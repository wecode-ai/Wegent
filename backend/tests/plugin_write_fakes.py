"""Thread-safe Redis lease doubles for plugin service unit tests."""

import threading
import time
import uuid
from typing import Any

from redis.exceptions import LockNotOwnedError


class FakePluginRedis:
    def __init__(self) -> None:
        self.values: dict[str, tuple[str, float]] = {}
        self.mutex = threading.Lock()

    def lock(self, name: str, **options: Any) -> "FakePluginLock":
        return FakePluginLock(self, name, **options)


class FakePluginLock:
    def __init__(
        self,
        redis: FakePluginRedis,
        name: str,
        *,
        timeout: float,
        blocking_timeout: float,
        thread_local: bool,
    ) -> None:
        self.redis = redis
        self.name = name
        self.timeout = timeout
        self.blocking_timeout = blocking_timeout
        self.token = ""

    def owned(self) -> bool:
        with self.redis.mutex:
            value = self.redis.values.get(self.name)
            return bool(
                value and value[0] == self.token and value[1] > time.monotonic()
            )

    def acquire(self, token: str | None = None) -> bool:
        token = token if token is not None else uuid.uuid4().hex
        deadline = time.monotonic() + self.blocking_timeout
        while True:
            with self.redis.mutex:
                value = self.redis.values.get(self.name)
                now = time.monotonic()
                if value is None or value[1] <= now:
                    self.redis.values[self.name] = (token, now + self.timeout)
                    self.token = token
                    return True
            if time.monotonic() >= deadline:
                return False
            time.sleep(0.001)

    def reacquire(self) -> bool:
        with self.redis.mutex:
            value = self.redis.values.get(self.name)
            if not value or value[0] != self.token or value[1] <= time.monotonic():
                raise LockNotOwnedError()
            self.redis.values[self.name] = (self.token, time.monotonic() + self.timeout)
            return True

    def release(self) -> None:
        with self.redis.mutex:
            value = self.redis.values.get(self.name)
            if value is None or value[0] != self.token:
                raise LockNotOwnedError()
            del self.redis.values[self.name]
