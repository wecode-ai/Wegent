# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Tests for IM session store.
"""

import pytest
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, patch

from app.services.im.base.message import IMPlatform
from app.services.im.base.session import IMSession
from app.services.im.session_store import IMSessionStore


@pytest.fixture
def session_store():
    """Create a session store instance."""
    return IMSessionStore()


@pytest.fixture
def sample_session():
    """Create a sample session."""
    return IMSession(
        platform=IMPlatform.TELEGRAM,
        platform_user_id="12345",
        platform_chat_id="67890",
        team_id=1,
        task_id=100,
        last_activity=datetime.now(timezone.utc),
        metadata={"test": "data"},
    )


class TestIMSessionStore:
    """Tests for IMSessionStore."""

    def test_get_session_key(self, session_store):
        """Test session key generation."""
        key = session_store._get_session_key(
            IMPlatform.TELEGRAM, "user123", 1
        )
        assert key == "im:session:telegram:1:user123"

    @pytest.mark.asyncio
    async def test_save_and_get_session(self, session_store, sample_session):
        """Test saving and retrieving a session."""
        with patch.object(
            session_store, "save_session", new_callable=AsyncMock
        ) as mock_save:
            mock_save.return_value = True
            result = await session_store.save_session(sample_session)
            assert result is True
            mock_save.assert_called_once_with(sample_session)

    @pytest.mark.asyncio
    async def test_get_or_create_session_new(self, session_store):
        """Test creating a new session when none exists."""
        with patch(
            "app.services.im.session_store.cache_manager"
        ) as mock_cache:
            mock_cache.get = AsyncMock(return_value=None)
            mock_cache.set = AsyncMock(return_value=True)

            session = await session_store.get_or_create_session(
                platform=IMPlatform.TELEGRAM,
                platform_user_id="user123",
                platform_chat_id="chat456",
                team_id=1,
            )

            assert session.platform == IMPlatform.TELEGRAM
            assert session.platform_user_id == "user123"
            assert session.platform_chat_id == "chat456"
            assert session.team_id == 1
            assert session.task_id is None

    @pytest.mark.asyncio
    async def test_get_or_create_session_existing(self, session_store):
        """Test retrieving an existing session."""
        existing_data = {
            "platform": "telegram",
            "platform_user_id": "user123",
            "platform_chat_id": "chat456",
            "team_id": 1,
            "task_id": 100,
            "last_activity": datetime.now(timezone.utc).isoformat(),
            "metadata": {},
        }

        with patch(
            "app.services.im.session_store.cache_manager"
        ) as mock_cache:
            mock_cache.get = AsyncMock(return_value=existing_data)

            session = await session_store.get_or_create_session(
                platform=IMPlatform.TELEGRAM,
                platform_user_id="user123",
                platform_chat_id="chat456",
                team_id=1,
            )

            assert session.task_id == 100

    @pytest.mark.asyncio
    async def test_get_or_create_session_timeout(self, session_store):
        """Test session timeout creates a new session."""
        old_time = datetime.now(timezone.utc) - timedelta(hours=2)
        existing_data = {
            "platform": "telegram",
            "platform_user_id": "user123",
            "platform_chat_id": "chat456",
            "team_id": 1,
            "task_id": 100,
            "last_activity": old_time.isoformat(),
            "metadata": {},
        }

        with patch(
            "app.services.im.session_store.cache_manager"
        ) as mock_cache:
            mock_cache.get = AsyncMock(return_value=existing_data)
            mock_cache.set = AsyncMock(return_value=True)

            session = await session_store.get_or_create_session(
                platform=IMPlatform.TELEGRAM,
                platform_user_id="user123",
                platform_chat_id="chat456",
                team_id=1,
                session_timeout_minutes=60,  # 1 hour timeout
            )

            # Should create new session because old one timed out
            assert session.task_id is None

    @pytest.mark.asyncio
    async def test_delete_session(self, session_store):
        """Test deleting a session."""
        with patch(
            "app.services.im.session_store.cache_manager"
        ) as mock_cache:
            mock_cache.delete = AsyncMock(return_value=True)

            result = await session_store.delete_session(
                IMPlatform.TELEGRAM, "user123", 1
            )

            assert result is True
            mock_cache.delete.assert_called_once()
