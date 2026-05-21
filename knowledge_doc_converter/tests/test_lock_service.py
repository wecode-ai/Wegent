"""Tests for lock_service module."""

import threading
from unittest.mock import MagicMock, patch

import pytest

from knowledge_doc_converter.services.lock_service import DistributedLock


@pytest.fixture
def lock():
    """Create a DistributedLock with mocked Redis."""
    lck = DistributedLock()
    mock_redis = MagicMock()
    lck._redis = mock_redis
    return lck, mock_redis


class TestDistributedLock:
    """Tests for DistributedLock."""

    def test_acquire_success(self, lock):
        lck, mock_redis = lock
        mock_redis.set.return_value = True
        assert lck.acquire("test-lock", expire_seconds=60) is True
        mock_redis.set.assert_called_once_with(
            "wegent:lock:test-lock", "1", nx=True, ex=60
        )

    def test_acquire_failure(self, lock):
        lck, mock_redis = lock
        mock_redis.set.return_value = None
        assert lck.acquire("test-lock", expire_seconds=60) is False

    def test_release(self, lock):
        lck, mock_redis = lock
        lck.release("test-lock")
        mock_redis.delete.assert_called_once_with("wegent:lock:test-lock")

    def test_extend(self, lock):
        lck, mock_redis = lock
        lck.extend("test-lock", expire_seconds=120)
        mock_redis.expire.assert_called_once_with("wegent:lock:test-lock", 120)

    def test_watchdog_context_acquired(self, lock):
        lck, mock_redis = lock
        mock_redis.set.return_value = True

        with lck.acquire_watchdog_context("test-lock", 60, 10) as acquired:
            assert acquired is True
        # Lock should be released after context exit
        mock_redis.delete.assert_called_once_with("wegent:lock:test-lock")

    def test_watchdog_context_not_acquired(self, lock):
        lck, mock_redis = lock
        mock_redis.set.return_value = None

        with lck.acquire_watchdog_context("test-lock", 60, 10) as acquired:
            assert acquired is False
        # No release should happen if not acquired
        mock_redis.delete.assert_not_called()

    def test_prefixed_key(self, lock):
        lck, _ = lock
        assert lck._prefixed("my-lock") == "wegent:lock:my-lock"
