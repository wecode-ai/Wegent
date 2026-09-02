# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Isolation and hard-boundary tests for Skill multipart uploads."""

import asyncio
import io
import json
import threading
from types import SimpleNamespace

import pytest
from fastapi import HTTPException, UploadFile

from app.api.endpoints.kind import skills
from app.core.bounded_executor import BoundedExecutor, BoundedExecutorOverloaded
from app.schemas.kind import Skill


class TrackingFile(io.BytesIO):
    def __init__(self, payload: bytes) -> None:
        super().__init__(payload)
        self.read_sizes: list[int] = []
        self.read_thread_ids: list[int] = []

    def read(self, size: int = -1) -> bytes:
        self.read_sizes.append(size)
        self.read_thread_ids.append(threading.get_ident())
        return super().read(size)


def _skill() -> Skill:
    return Skill(
        metadata={"name": "bounded-skill", "labels": {"id": "17"}},
        spec={"description": "bounded upload"},
    )


async def _upload(file_object: io.BytesIO) -> Skill:
    return await skills.upload_skill(
        file=UploadFile(file=file_object, filename="bounded.zip"),
        name="bounded-skill",
        namespace="default",
        current_user=SimpleNamespace(id=7),
    )


@pytest.mark.asyncio
async def test_skill_exact_compressed_limit_is_accepted_and_session_is_closed(
    monkeypatch,
) -> None:
    file_object = TrackingFile(b"1234")
    session = SimpleNamespace(closed=False)
    opened_sessions = 0
    response = _skill()

    class SessionContext:
        def __enter__(self):
            nonlocal opened_sessions
            opened_sessions += 1
            return session

        def __exit__(self, exc_type, exc, traceback):
            session.closed = True

    def create_skill(**kwargs):
        assert kwargs["db"] is session
        assert kwargs["file_content"] == b"1234"
        return response

    monkeypatch.setattr(skills.SkillValidator, "MAX_SIZE", 4)
    monkeypatch.setattr(skills.db_session, "SessionLocal", SessionContext)
    monkeypatch.setattr(
        skills,
        "_load_upload_user",
        lambda db, user_id, require_admin: SimpleNamespace(id=user_id),
    )
    monkeypatch.setattr(skills.skill_kinds_service, "create_skill", create_skill)

    result = await _upload(file_object)

    assert result is response
    assert opened_sessions == 1
    assert session.closed is True
    assert file_object.read_sizes == [5, 1]
    assert all(
        thread_id != threading.get_ident() for thread_id in file_object.read_thread_ids
    )


@pytest.mark.asyncio
async def test_skill_rejects_one_byte_over_compressed_limit_before_database(
    monkeypatch,
) -> None:
    file_object = TrackingFile(b"12345")
    monkeypatch.setattr(skills.SkillValidator, "MAX_SIZE", 4)
    monkeypatch.setattr(
        skills.db_session,
        "SessionLocal",
        lambda: (_ for _ in ()).throw(
            AssertionError("oversized uploads must not open a database session")
        ),
    )

    with pytest.raises(HTTPException) as exc_info:
        await _upload(file_object)

    assert exc_info.value.status_code == 413
    assert file_object.read_sizes == [5]


@pytest.mark.asyncio
async def test_public_upload_file_and_json_work_do_not_block_event_loop(
    monkeypatch,
) -> None:
    entered = threading.Event()
    release = threading.Event()
    worker_thread_ids: list[int] = []
    file_object = TrackingFile(b"zip")
    session = SimpleNamespace(closed=False)
    original_loads = json.loads

    class SessionContext:
        def __enter__(self):
            return session

        def __exit__(self, exc_type, exc, traceback):
            session.closed = True

    def blocking_json_loads(payload: str):
        worker_thread_ids.append(threading.get_ident())
        entered.set()
        assert release.wait(timeout=2)
        return original_loads(payload)

    monkeypatch.setattr(skills.json, "loads", blocking_json_loads)
    monkeypatch.setattr(skills.db_session, "SessionLocal", SessionContext)
    monkeypatch.setattr(
        skills,
        "_load_upload_user",
        lambda db, user_id, require_admin: SimpleNamespace(id=user_id),
    )
    monkeypatch.setattr(
        skills.marketplace_tag_service,
        "validate_resource_tags",
        lambda *_args, **_kwargs: ["tag-1"],
    )
    monkeypatch.setattr(
        skills.skill_kinds_service,
        "create_skill",
        lambda **_kwargs: _skill(),
    )
    monkeypatch.setattr(
        skills.resource_library_service,
        "update_publication",
        lambda *_args, **_kwargs: None,
    )
    monkeypatch.setattr(
        skills.public_skill_service,
        "get_skill_by_id",
        lambda *_args, **_kwargs: {"id": 17},
    )
    task = asyncio.create_task(
        skills.upload_public_skill(
            file=UploadFile(file=file_object, filename="bounded.zip"),
            name="bounded-skill",
            marketplace_tags="[]",
            current_user=SimpleNamespace(id=1),
        )
    )

    try:
        assert await asyncio.to_thread(entered.wait, 1)
        loop_tick = asyncio.Event()
        asyncio.get_running_loop().call_soon(loop_tick.set)
        await asyncio.wait_for(loop_tick.wait(), timeout=0.1)
        assert not task.done()
    finally:
        release.set()

    assert await task == {"id": 17}
    assert session.closed is True
    assert worker_thread_ids[0] != threading.get_ident()
    assert all(
        thread_id != threading.get_ident() for thread_id in file_object.read_thread_ids
    )


@pytest.mark.asyncio
async def test_skill_upload_rejects_when_bounded_worker_capacity_is_exhausted(
    monkeypatch,
) -> None:
    entered = threading.Event()
    release = threading.Event()
    executor = BoundedExecutor(
        max_workers=1,
        max_in_flight=1,
        max_waiters=0,
        thread_name_prefix="test-skill-overload",
    )

    def blocking_upload(*_args, **_kwargs):
        entered.set()
        assert release.wait(timeout=2)
        return _skill()

    monkeypatch.setattr(skills, "_SKILL_UPLOAD_EXECUTOR", executor)
    monkeypatch.setattr(skills, "_create_skill_upload_sync", blocking_upload)
    first = asyncio.create_task(_upload(io.BytesIO(b"first")))

    try:
        assert await asyncio.to_thread(entered.wait, 1)
        with pytest.raises(BoundedExecutorOverloaded):
            await _upload(io.BytesIO(b"second"))
    finally:
        release.set()

    await first


@pytest.mark.asyncio
async def test_all_skill_upload_endpoints_submit_to_the_bounded_executor(
    monkeypatch,
) -> None:
    submitted = []
    response = _skill()

    class RecordingExecutor:
        async def run(self, function):
            submitted.append(function)
            return response

    monkeypatch.setattr(skills, "_SKILL_UPLOAD_EXECUTOR", RecordingExecutor())
    current_user = SimpleNamespace(id=7)

    results = [
        await skills.upload_skill(
            file=UploadFile(file=io.BytesIO(b"zip"), filename="bounded.zip"),
            name="bounded",
            namespace="default",
            current_user=current_user,
        ),
        await skills.upload_public_skill(
            file=UploadFile(file=io.BytesIO(b"zip"), filename="bounded.zip"),
            name="bounded",
            marketplace_tags="[]",
            current_user=current_user,
        ),
        await skills.update_public_skill_with_upload(
            skill_id=17,
            file=UploadFile(file=io.BytesIO(b"zip"), filename="bounded.zip"),
            current_user=current_user,
        ),
        await skills.update_skill(
            skill_id=17,
            file=UploadFile(file=io.BytesIO(b"zip"), filename="bounded.zip"),
            current_user=current_user,
        ),
    ]

    assert results == [response] * 4
    assert [function.func for function in submitted] == [
        skills._create_skill_upload_sync,
        skills._create_public_skill_upload_sync,
        skills._update_public_skill_upload_sync,
        skills._update_skill_upload_sync,
    ]


def test_skill_upload_route_paths_and_methods_are_stable() -> None:
    route_endpoints = {
        (route.path, method): route.endpoint
        for route in skills.router.routes
        if hasattr(route, "endpoint")
        for method in route.methods
    }

    assert route_endpoints[("/kinds/skills/upload", "POST")] is skills.upload_skill
    assert (
        route_endpoints[("/kinds/skills/public/upload", "POST")]
        is skills.upload_public_skill
    )
    assert (
        route_endpoints[("/kinds/skills/public/{skill_id}/upload", "PUT")]
        is skills.update_public_skill_with_upload
    )
    assert route_endpoints[("/kinds/skills/{skill_id}", "PUT")] is skills.update_skill
