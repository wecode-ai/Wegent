# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Event-loop isolation contracts for mixed admin endpoints."""

import asyncio
import io
import threading
from datetime import datetime
from types import SimpleNamespace
from unittest.mock import patch

import pytest
from starlette.datastructures import UploadFile

from app.api.endpoints.admin import device_monitor, im_channels, public_teams
from app.schemas.im_channel import IMChannelCreate


async def _wait_for_worker_without_blocking_loop(
    task: asyncio.Task,
    started: threading.Event,
    release: threading.Event,
) -> None:
    """Prove the test loop runs while the synchronous phase is blocked."""
    fallback = threading.Timer(1.0, release.set)
    fallback.start()
    try:
        assert await asyncio.wait_for(
            asyncio.to_thread(started.wait, 0.5),
            timeout=0.75,
        )
        await asyncio.sleep(0)
        assert not task.done()
    finally:
        release.set()
        fallback.cancel()


@pytest.mark.asyncio
async def test_admin_device_db_phase_is_bounded_and_does_not_block_loop(
    test_admin_user,
):
    started = threading.Event()
    release = threading.Event()
    worker_threads: list[str] = []
    redis_threads: list[str] = []

    def slow_load(*_args):
        worker_threads.append(threading.current_thread().name)
        started.set()
        release.wait()
        return device_monitor._AdminDeviceQuerySnapshot(
            records=(
                device_monitor._AdminDeviceRecord(
                    id=1,
                    device_id="device-1",
                    name="Device 1",
                    device_type="local",
                    bind_shell="claudecode",
                    user_id=1,
                    user_name="user",
                    client_ip=None,
                    created_at=None,
                ),
            ),
            total=1,
        )

    async def load_redis(_keys):
        redis_threads.append(threading.current_thread().name)
        return {}

    with (
        patch.object(
            device_monitor,
            "_load_device_query_snapshot_from_store",
            new=slow_load,
        ),
        patch.object(device_monitor.cache_manager, "mget", new=load_redis),
    ):
        task = asyncio.create_task(
            device_monitor.get_all_devices(
                page=1,
                limit=20,
                status=None,
                device_type=None,
                bind_shell=None,
                search=None,
                version_op=None,
                version=None,
                current_user=test_admin_user,
            )
        )
        await _wait_for_worker_without_blocking_loop(task, started, release)
        response = await task

    assert response.total == 1
    assert worker_threads and worker_threads[0].startswith("wegent-db")
    assert redis_threads == [threading.main_thread().name]


@pytest.mark.asyncio
async def test_im_channel_db_phase_is_bounded_before_worker_rpc(test_admin_user):
    started = threading.Event()
    release = threading.Event()
    worker_threads: list[str] = []
    rpc_threads: list[str] = []
    now = datetime.now()
    snapshot = im_channels._IMChannelSnapshot(
        id=7,
        name="weibo-main",
        namespace="default",
        json={
            "spec": {
                "channelType": "weibo",
                "isEnabled": True,
                "config": {},
                "defaultTeamId": 0,
                "defaultModelName": "",
            }
        },
        created_at=now,
        updated_at=now,
    )

    def slow_create(_channel_data):
        worker_threads.append(threading.current_thread().name)
        started.set()
        release.wait()
        return snapshot

    async def reconcile(channel_id):
        rpc_threads.append(threading.current_thread().name)
        assert channel_id == snapshot.id
        return True

    worker_client = SimpleNamespace(reconcile=reconcile)
    with (
        patch.object(im_channels, "_create_channel_in_store", new=slow_create),
        patch.object(im_channels, "channel_worker_client", new=worker_client),
    ):
        task = asyncio.create_task(
            im_channels.create_im_channel(
                channel_data=IMChannelCreate(
                    name="weibo-main",
                    channel_type="weibo",
                    config={},
                    is_enabled=True,
                ),
                current_user=test_admin_user,
            )
        )
        await _wait_for_worker_without_blocking_loop(task, started, release)
        response = await task

    assert response.id == snapshot.id
    assert worker_threads and worker_threads[0].startswith("wegent-db")
    assert rpc_threads == [threading.main_thread().name]


@pytest.mark.asyncio
async def test_public_team_icon_processing_is_bounded_and_does_not_block_loop(
    test_admin_user,
):
    started = threading.Event()
    release = threading.Event()
    worker_threads: list[str] = []

    def slow_store(_user_id, _content):
        worker_threads.append(threading.current_thread().name)
        started.set()
        release.wait()
        return public_teams.PublicTeamIconUploadResponse(
            asset_id=9,
            url="/api/resource-library/assets/team-icons/9",
        )

    upload = UploadFile(file=io.BytesIO(b"image"), filename="team.png")
    with patch.object(public_teams, "_store_public_team_icon", new=slow_store):
        task = asyncio.create_task(
            public_teams.upload_public_team_icon(
                file=upload,
                current_user=test_admin_user,
            )
        )
        await _wait_for_worker_without_blocking_loop(task, started, release)
        response = await task

    assert response.asset_id == 9
    assert worker_threads and worker_threads[0].startswith("wegent-db")
