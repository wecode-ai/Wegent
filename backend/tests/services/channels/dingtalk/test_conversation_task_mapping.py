# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for rebuilding the conversation -> task mapping of a private chat."""

from datetime import datetime, timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, call

import pytest

from app.services.channels import handler as base_handler_module
from app.services.channels.dingtalk.handler import DingTalkChannelHandler
from app.services.channels.handler import (
    CHANNEL_CONV_TASK_PREFIX,
    CHANNEL_CONV_TASK_TTL,
)


def _patch_dependencies(
    monkeypatch: pytest.MonkeyPatch,
    *,
    cached_task_id,
    mirrored_task_id,
    task,
):
    cache = AsyncMock()
    cache.get.return_value = cached_task_id
    session_service = AsyncMock()
    session_service.get_chat_task.return_value = mirrored_task_id
    store = Mock()
    store.get_by_id.return_value = task
    db = Mock()

    monkeypatch.setattr(base_handler_module, "cache_manager", cache)
    monkeypatch.setattr(base_handler_module, "im_session_service", session_service)
    monkeypatch.setattr(base_handler_module, "task_store", store)
    monkeypatch.setattr(base_handler_module, "SessionLocal", Mock(return_value=db))
    return cache, session_service, store, db


def _mapping_key(conversation_id: str, user_id: int) -> str:
    return f"{CHANNEL_CONV_TASK_PREFIX}dingtalk:{conversation_id}:{user_id}"


@pytest.mark.asyncio
async def test_lost_mapping_is_restored_from_session_mirror(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    handler = DingTalkChannelHandler(channel_id=77)
    task = SimpleNamespace(user_id=9, updated_at=datetime.now())
    cache, session_service, store, db = _patch_dependencies(
        monkeypatch, cached_task_id=None, mirrored_task_id=42, task=task
    )

    task_id, auto_new_conversation = await handler._get_conversation_task_id(
        "conv-private", 9
    )

    assert (task_id, auto_new_conversation) == (42, False)
    session_service.get_chat_task.assert_awaited_once_with(
        user_id=9,
        channel_type="dingtalk",
        channel_id=77,
        conversation_id="conv-private",
    )
    cache.set.assert_awaited_once_with(
        _mapping_key("conv-private", 9), 42, expire=CHANNEL_CONV_TASK_TTL
    )
    session_service.remember_chat_task.assert_awaited_once()
    # The restore path verifies ownership, then the timeout check reads it again.
    assert store.get_by_id.call_count == 2
    assert store.get_by_id.call_args_list[-1] == call(db, task_id=42)
    assert db.close.call_count == 2


@pytest.mark.asyncio
async def test_mirrored_task_of_another_user_is_not_restored(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    handler = DingTalkChannelHandler(channel_id=77)
    task = SimpleNamespace(user_id=8, updated_at=datetime.now())
    cache, session_service, _, _ = _patch_dependencies(
        monkeypatch, cached_task_id=None, mirrored_task_id=42, task=task
    )

    task_id, auto_new_conversation = await handler._get_conversation_task_id(
        "conv-private", 9
    )

    assert (task_id, auto_new_conversation) == (None, False)
    cache.set.assert_not_awaited()
    session_service.remember_chat_task.assert_not_awaited()


@pytest.mark.asyncio
async def test_mirrored_task_that_no_longer_exists_is_not_restored(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    handler = DingTalkChannelHandler(channel_id=77)
    cache, session_service, _, _ = _patch_dependencies(
        monkeypatch, cached_task_id=None, mirrored_task_id=42, task=None
    )

    task_id, auto_new_conversation = await handler._get_conversation_task_id(
        "conv-private", 9
    )

    assert (task_id, auto_new_conversation) == (None, False)
    cache.set.assert_not_awaited()
    session_service.remember_chat_task.assert_not_awaited()


@pytest.mark.asyncio
async def test_missing_mirror_keeps_new_conversation_behavior(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    handler = DingTalkChannelHandler(channel_id=77)
    cache, _, _, _ = _patch_dependencies(
        monkeypatch, cached_task_id=None, mirrored_task_id=None, task=None
    )

    task_id, auto_new_conversation = await handler._get_conversation_task_id(
        "conv-private", 9
    )

    assert (task_id, auto_new_conversation) == (None, False)
    cache.set.assert_not_awaited()


@pytest.mark.asyncio
async def test_conversation_timeout_clears_cache_and_mirror(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    handler = DingTalkChannelHandler(channel_id=77)
    stale_task = SimpleNamespace(
        user_id=9, updated_at=datetime.now() - timedelta(days=2)
    )
    cache, session_service, _, _ = _patch_dependencies(
        monkeypatch, cached_task_id="42", mirrored_task_id=None, task=stale_task
    )

    task_id, auto_new_conversation = await handler._get_conversation_task_id(
        "conv-private", 9
    )

    assert (task_id, auto_new_conversation) == (None, True)
    cache.delete.assert_awaited_once_with(_mapping_key("conv-private", 9))
    session_service.forget_chat_task.assert_awaited_once_with(
        user_id=9,
        channel_type="dingtalk",
        channel_id=77,
        conversation_id="conv-private",
    )


@pytest.mark.asyncio
async def test_set_and_delete_mirror_the_private_session(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    handler = DingTalkChannelHandler(channel_id=77)
    cache, session_service, _, _ = _patch_dependencies(
        monkeypatch, cached_task_id=None, mirrored_task_id=None, task=None
    )

    await handler._set_conversation_task_id("conv-private", 9, 42)

    cache.set.assert_awaited_once_with(
        _mapping_key("conv-private", 9), 42, expire=CHANNEL_CONV_TASK_TTL
    )
    session_service.remember_chat_task.assert_awaited_once_with(
        user_id=9,
        channel_type="dingtalk",
        channel_id=77,
        conversation_id="conv-private",
        task_id=42,
    )

    await handler._delete_conversation_task_id("conv-private", 9)

    cache.delete.assert_awaited_once_with(_mapping_key("conv-private", 9))
    session_service.forget_chat_task.assert_awaited_once_with(
        user_id=9,
        channel_type="dingtalk",
        channel_id=77,
        conversation_id="conv-private",
    )
