# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Non-blocking boundaries for subscription notification dispatch."""

import asyncio
import threading
from unittest.mock import AsyncMock, patch

import pytest

from app.core import payload_codec
from app.services.subscription.notification_dispatcher import (
    SubscriptionNotificationDispatcher,
    _ExecutionNotificationPlan,
)


async def _wait_for_thread(started: threading.Event) -> None:
    while not started.is_set():
        await asyncio.sleep(0)


@pytest.mark.asyncio
async def test_notification_database_plan_does_not_block_event_loop():
    """Follower/channel SQL must finish in a worker before async delivery."""
    dispatcher = SubscriptionNotificationDispatcher()
    started = threading.Event()
    release = threading.Event()
    plan = _ExecutionNotificationPlan(
        subscription_id=1,
        execution_id=2,
        total_followers=0,
        silent_count=0,
        default_count=0,
        notify_count=0,
        followers=(),
    )

    def blocking_prepare(*_args):
        started.set()
        release.wait()
        return plan

    safety_release = threading.Timer(2, release.set)
    safety_release.start()
    try:
        with (
            patch.object(
                dispatcher,
                "_prepare_execution_notifications_from_store_sync",
                side_effect=blocking_prepare,
            ),
            patch.object(
                dispatcher,
                "_dispatch_execution_notification_plan",
                new=AsyncMock(return_value={"total_followers": 0}),
            ) as send_plan,
        ):
            dispatch = asyncio.create_task(
                dispatcher.dispatch_execution_notifications_from_store(
                    subscription_id=1,
                    execution_id=2,
                    subscription_display_name="Daily briefing",
                    result_summary="done",
                    status="COMPLETED",
                )
            )
            await asyncio.wait_for(_wait_for_thread(started), timeout=0.5)
            assert not dispatch.done()
            release.set()
            assert await dispatch == {"total_followers": 0}
            send_plan.assert_awaited_once_with(plan)
    finally:
        release.set()
        safety_release.cancel()


@pytest.mark.asyncio
async def test_dingtalk_webhook_response_decode_runs_outside_event_loop(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    loop_thread = threading.get_ident()
    decoder_thread: int | None = None
    encoder_thread: int | None = None
    original_encode = payload_codec._encode_http_json_bytes

    def observed_encode(payload: object) -> bytes:
        nonlocal encoder_thread
        encoder_thread = threading.get_ident()
        return original_encode(payload)

    monkeypatch.setattr(
        payload_codec,
        "_encode_http_json_bytes",
        observed_encode,
    )
    large_summary = "x" * payload_codec.PAYLOAD_CODEC_OFFLOAD_THRESHOLD_BYTES

    class FakeResponse:
        content = b'{"errcode":0}'
        status_code = 200

        def raise_for_status(self) -> None:
            return None

        def json(self) -> dict[str, int]:
            nonlocal decoder_thread
            decoder_thread = threading.get_ident()
            return {"errcode": 0}

    class FakeClient:
        def __init__(self, timeout: float):
            assert timeout == 30.0

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return None

        async def post(
            self,
            url: str,
            content: bytes,
            headers: dict[str, str],
        ):
            assert url == "https://example.test/dingtalk"
            assert b'"msgtype":"markdown"' in content
            assert headers == {"Content-Type": "application/json"}
            return FakeResponse()

    monkeypatch.setattr(
        "app.services.subscription.notification_dispatcher.httpx.AsyncClient",
        FakeClient,
    )

    result = await SubscriptionNotificationDispatcher()._send_dingtalk_webhook(
        url="https://example.test/dingtalk",
        secret=None,
        subscription_display_name="Daily briefing",
        result_summary=large_summary,
        status="COMPLETED",
    )

    assert result == {"success": True}
    assert encoder_thread is not None
    assert encoder_thread != loop_thread
    assert decoder_thread is not None
    assert decoder_thread != loop_thread
