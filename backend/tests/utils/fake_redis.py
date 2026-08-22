# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""In-memory Redis stand-ins for tests that exercise external event buffering."""

from __future__ import annotations

from redis.exceptions import WatchError


class FakeRedis:
    """Minimal in-memory Redis client for buffer tests."""

    def __init__(self) -> None:
        self.store: dict[bytes, bytes] = {}

    def get(self, key: bytes | str) -> bytes | None:
        return self.store.get(key if isinstance(key, bytes) else key.encode())

    def set(self, key: bytes | str, value: bytes | str, ex: int | None = None) -> bool:
        self.store[key if isinstance(key, bytes) else key.encode()] = (
            value if isinstance(value, bytes) else value.encode()
        )
        return True

    def delete(self, *keys: bytes | str) -> int:
        count = 0
        for key in keys:
            encoded = key if isinstance(key, bytes) else key.encode()
            if encoded in self.store:
                del self.store[encoded]
                count += 1
        return count

    def getdel(self, key: bytes | str) -> bytes | None:
        return self.store.pop(key if isinstance(key, bytes) else key.encode(), None)

    def scan_iter(self, pattern: str = "*", count: int = 100):
        del count
        prefix = pattern.split("*")[0].encode()
        return (key for key in self.store if key.startswith(prefix))

    def pipeline(self) -> "FakePipeline":
        return FakePipeline(self)


class FakePipeline:
    """In-memory WATCH/MULTI pipeline mirroring the redis-py contract."""

    def __init__(self, redis: FakeRedis) -> None:
        self.redis = redis
        self._watched: dict[bytes, bytes | None] = {}
        self._buffered: list[tuple] = []
        self._in_transaction = False

    def __enter__(self) -> "FakePipeline":
        return self

    def __exit__(self, *exc_info: object) -> None:
        self._watched = {}
        self._buffered = []
        self._in_transaction = False

    def watch(self, *keys: bytes | str) -> "FakePipeline":
        for key in keys:
            encoded = key if isinstance(key, bytes) else key.encode()
            self._watched[encoded] = self.redis.store.get(encoded)
        return self

    def get(self, key: bytes | str) -> bytes | None:
        return self.redis.get(key)

    def set(self, key: bytes | str, value: bytes | str, ex: int | None = None):
        if self._in_transaction:
            self._buffered.append(("set", key, value, ex))
        else:
            self.redis.set(key, value, ex)
        return self

    def delete(self, *keys: bytes | str) -> "FakePipeline":
        if self._in_transaction:
            self._buffered.append(("delete", keys))
        else:
            self.redis.delete(*keys)
        return self

    def multi(self) -> "FakePipeline":
        self._in_transaction = True
        self._buffered = []
        return self

    def execute(self) -> list[object]:
        for key, snapshot in self._watched.items():
            if self.redis.store.get(key) != snapshot:
                raise WatchError("Watched key changed during transaction")
        results = []
        for command in self._buffered:
            if command[0] == "set":
                results.append(self.redis.set(command[1], command[2], command[3]))
            elif command[0] == "delete":
                results.append(self.redis.delete(*command[1]))
        return results
