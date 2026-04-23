# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Snowflake ID generator."""

import threading
import time


class SnowflakeGenerator:
    """Twitter-style snowflake ID generator.

    64-bit ID structure:
    - 1 bit: sign (always 0)
    - 41 bits: timestamp (milliseconds since epoch)
    - 10 bits: worker ID (0-1023)
    - 12 bits: sequence (0-4095)
    """

    def __init__(self, worker_id: int = 0, epoch: int = 1609459200000):
        """Initialize generator.

        Args:
            worker_id: Worker ID (0-1023)
            epoch: Custom epoch in milliseconds (default: 2021-01-01)
        """
        if worker_id < 0 or worker_id > 1023:
            raise ValueError("worker_id must be between 0 and 1023")
        self.worker_id = worker_id
        self.epoch = epoch
        self.sequence = 0
        self.last_timestamp = -1
        self._lock = threading.Lock()

    def _current_timestamp(self) -> int:
        return int(time.time() * 1000)

    def _wait_next_millis(self, last_timestamp: int) -> int:
        timestamp = self._current_timestamp()
        while timestamp <= last_timestamp:
            timestamp = self._current_timestamp()
        return timestamp

    def generate(self) -> int:
        """Generate next snowflake ID."""
        with self._lock:
            timestamp = self._current_timestamp()

            if timestamp < self.last_timestamp:
                raise RuntimeError("Clock moved backwards")

            if timestamp == self.last_timestamp:
                self.sequence = (self.sequence + 1) & 4095
                if self.sequence == 0:
                    timestamp = self._wait_next_millis(self.last_timestamp)
            else:
                self.sequence = 0

            self.last_timestamp = timestamp

            return (
                ((timestamp - self.epoch) << 22)
                | (self.worker_id << 12)
                | self.sequence
            )


# Global instance (worker_id=0 for single-node, scale by env var if needed)
_default_generator: SnowflakeGenerator | None = None
_lock = threading.Lock()


def get_snowflake_id() -> int:
    """Get next snowflake ID using default generator."""
    global _default_generator
    if _default_generator is None:
        with _lock:
            if _default_generator is None:
                _default_generator = SnowflakeGenerator(worker_id=0)
    return _default_generator.generate()
