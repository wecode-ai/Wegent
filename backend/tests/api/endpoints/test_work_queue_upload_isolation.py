# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Isolation and hard-boundary tests for Work Queue multipart ingestion."""

import asyncio
import io
import threading
from datetime import datetime, timezone
from types import SimpleNamespace

import pytest
from fastapi import HTTPException, UploadFile

from app.api.endpoints import work_queue
from app.core.bounded_executor import BoundedExecutor, BoundedExecutorOverloaded
from app.schemas.work_queue import (
    AutoProcessConfig,
    QueueMessagePriority,
    QueueMessageResponse,
    QueueMessageStatus,
)
from app.services.work_queue_service import QueueMessageService


class TrackingFile(io.BytesIO):
    """Record bounded read sizes and the threads that perform them."""

    def __init__(self, payload: bytes) -> None:
        super().__init__(payload)
        self.read_sizes: list[int] = []
        self.read_thread_ids: list[int] = []

    def read(self, size: int = -1) -> bytes:
        self.read_sizes.append(size)
        self.read_thread_ids.append(threading.get_ident())
        return super().read(size)


def _message_response() -> QueueMessageResponse:
    now = datetime.now(timezone.utc)
    return QueueMessageResponse(
        id=13,
        queueId=5,
        sender={"id": 7, "userName": "user-7"},
        sourceTaskId=0,
        sourceSubtaskIds=[],
        contentSnapshot=[{"role": "USER", "content": ""}],
        priority=QueueMessagePriority.NORMAL,
        status=QueueMessageStatus.UNREAD,
        createdAt=now,
        updatedAt=now,
        processedAt=now,
    )


async def _ingest(
    payloads: list[tuple[str, io.BytesIO]],
) -> QueueMessageResponse:
    return await work_queue.ingest_message_by_name(
        queue_name="inbox",
        current_user=SimpleNamespace(id=7),
        content=None,
        title=None,
        note=None,
        priority="normal",
        sender_external_id=None,
        sender_display_name=None,
        source_type=None,
        source_name=None,
        files=[
            UploadFile(file=file_object, filename=filename)
            for filename, file_object in payloads
        ],
    )


@pytest.mark.asyncio
async def test_ingest_file_io_and_processing_do_not_block_event_loop(
    monkeypatch,
) -> None:
    entered = threading.Event()
    release = threading.Event()
    worker_thread_ids: list[int] = []
    response = _message_response()

    def blocking_ingest(*_args, **_kwargs):
        worker_thread_ids.append(threading.get_ident())
        entered.set()
        assert release.wait(timeout=2)
        return response

    monkeypatch.setattr(
        work_queue,
        "_ingest_message_with_files_sync",
        blocking_ingest,
    )
    task = asyncio.create_task(_ingest([("note.txt", io.BytesIO(b"note"))]))

    try:
        assert await asyncio.to_thread(entered.wait, 1)
        loop_tick = asyncio.Event()
        asyncio.get_running_loop().call_soon(loop_tick.set)
        await asyncio.wait_for(loop_tick.wait(), timeout=0.1)
        assert not task.done()
    finally:
        release.set()

    assert await task is response
    assert worker_thread_ids == [worker_thread_ids[0]]
    assert worker_thread_ids[0] != threading.get_ident()


@pytest.mark.asyncio
async def test_ingest_exact_total_limit_closes_session_and_returns_detached_dto(
    monkeypatch,
) -> None:
    first_file = TrackingFile(b"12")
    second_file = TrackingFile(b"34")
    session = SimpleNamespace(closed=False)
    opened_sessions = 0
    uploaded: list[tuple[str, bytes]] = []
    response = _message_response()

    class SessionContext:
        def __enter__(self):
            nonlocal opened_sessions
            opened_sessions += 1
            return session

        def __exit__(self, exc_type, exc, traceback):
            session.closed = True

    def upload_attachment(**kwargs):
        uploaded.append((kwargs["filename"], kwargs["binary_data"]))
        return SimpleNamespace(id=10 + len(uploaded)), None

    def ingest_message_by_name(*, user_id, queue_name, request):
        assert user_id == 7
        assert queue_name == "inbox"
        assert request.attachmentContextIds == [11, 12]
        assert session.closed is True
        return response

    monkeypatch.setattr(
        work_queue.DocumentParser,
        "get_max_file_size",
        lambda: 4,
    )
    monkeypatch.setattr(work_queue.db_session, "SessionLocal", SessionContext)
    monkeypatch.setattr(
        work_queue.context_service,
        "upload_attachment",
        upload_attachment,
    )
    monkeypatch.setattr(
        work_queue.queue_message_service,
        "ingest_message_by_name",
        ingest_message_by_name,
    )

    result = await _ingest([("first.txt", first_file), ("second.txt", second_file)])

    assert result is response
    assert uploaded == [("first.txt", b"12"), ("second.txt", b"34")]
    assert opened_sessions == 1
    assert session.closed is True
    assert all(
        thread_id != threading.get_ident()
        for thread_id in first_file.read_thread_ids + second_file.read_thread_ids
    )


@pytest.mark.asyncio
async def test_ingest_rejects_one_byte_over_total_limit_before_database(
    monkeypatch,
) -> None:
    first_file = TrackingFile(b"12")
    second_file = TrackingFile(b"345")
    monkeypatch.setattr(
        work_queue.DocumentParser,
        "get_max_file_size",
        lambda: 4,
    )
    monkeypatch.setattr(
        work_queue.db_session,
        "SessionLocal",
        lambda: (_ for _ in ()).throw(
            AssertionError("oversized uploads must not open a database session")
        ),
    )

    with pytest.raises(HTTPException) as exc_info:
        await _ingest([("first.txt", first_file), ("second.txt", second_file)])

    assert exc_info.value.status_code == 413
    assert "Combined attachment size" in exc_info.value.detail
    assert max(first_file.read_sizes + second_file.read_sizes) <= 5


@pytest.mark.asyncio
async def test_ingest_rejects_one_byte_over_individual_file_limit(
    monkeypatch,
) -> None:
    file_object = TrackingFile(b"12345")
    monkeypatch.setattr(
        work_queue.DocumentParser,
        "get_max_file_size",
        lambda: 4,
    )
    monkeypatch.setattr(
        work_queue.db_session,
        "SessionLocal",
        lambda: (_ for _ in ()).throw(
            AssertionError("oversized uploads must not open a database session")
        ),
    )

    with pytest.raises(HTTPException) as exc_info:
        await _ingest([("oversized.txt", file_object)])

    assert exc_info.value.status_code == 413
    assert "File 'oversized.txt'" in exc_info.value.detail
    assert file_object.read_sizes == [5]


@pytest.mark.asyncio
async def test_ingest_rejects_file_count_before_reading_or_database(
    monkeypatch,
) -> None:
    files = [TrackingFile(b"x") for _ in range(21)]
    monkeypatch.setattr(
        work_queue.db_session,
        "SessionLocal",
        lambda: (_ for _ in ()).throw(
            AssertionError("excess file counts must not open a database session")
        ),
    )

    with pytest.raises(HTTPException) as exc_info:
        await _ingest(
            [(f"{index}.txt", file_object) for index, file_object in enumerate(files)]
        )

    assert exc_info.value.status_code == 413
    assert all(not file_object.read_sizes for file_object in files)


@pytest.mark.asyncio
async def test_ingest_rejects_when_bounded_worker_capacity_is_exhausted(
    monkeypatch,
) -> None:
    entered = threading.Event()
    release = threading.Event()
    executor = BoundedExecutor(
        max_workers=1,
        max_in_flight=1,
        max_waiters=0,
        thread_name_prefix="test-work-queue-overload",
    )

    def blocking_ingest(*_args, **_kwargs):
        entered.set()
        assert release.wait(timeout=2)
        return _message_response()

    monkeypatch.setattr(work_queue, "_WORK_QUEUE_UPLOAD_EXECUTOR", executor)
    monkeypatch.setattr(
        work_queue,
        "_ingest_message_with_files_sync",
        blocking_ingest,
    )
    first = asyncio.create_task(_ingest([("first.txt", io.BytesIO(b"first"))]))

    try:
        assert await asyncio.to_thread(entered.wait, 1)
        with pytest.raises(BoundedExecutorOverloaded):
            await _ingest([("second.txt", io.BytesIO(b"second"))])
    finally:
        release.set()

    await first


@pytest.mark.asyncio
async def test_manual_process_database_preparation_does_not_block_event_loop(
    monkeypatch,
) -> None:
    from app.services.inbox.direct_agent_handler import inbox_direct_agent_handler

    entered = threading.Event()
    release = threading.Event()
    worker_thread_ids: list[int] = []
    response = _message_response()
    service = QueueMessageService()

    def blocking_prepare(user_id: int, message_id: int):
        assert (user_id, message_id) == (7, 13)
        worker_thread_ids.append(threading.get_ident())
        entered.set()
        assert release.wait(timeout=2)
        return (
            SimpleNamespace(message_id=13),
            AutoProcessConfig(enabled=True, mode="direct_agent"),
        )

    async def handle(_event, _auto_process) -> None:
        return None

    monkeypatch.setattr(service, "_prepare_manual_process_sync", blocking_prepare)
    monkeypatch.setattr(
        service,
        "_load_message_response_sync",
        lambda message_id: response,
    )
    monkeypatch.setattr(inbox_direct_agent_handler, "handle", handle)
    task = asyncio.create_task(service.process_message(user_id=7, message_id=13))

    try:
        assert await asyncio.to_thread(entered.wait, 1)
        loop_tick = asyncio.Event()
        asyncio.get_running_loop().call_soon(loop_tick.set)
        await asyncio.wait_for(loop_tick.wait(), timeout=0.1)
        assert not task.done()
    finally:
        release.set()

    assert await task is response
    assert worker_thread_ids[0] != threading.get_ident()
