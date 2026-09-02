# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

import asyncio
import io
import json
import threading
from types import SimpleNamespace

import pytest
from fastapi import HTTPException, UploadFile
from fastapi.responses import Response
from starlette.requests import Request

from app.api.endpoints.adapter import attachments
from app.core.bounded_executor import BoundedExecutor, BoundedExecutorOverloaded
from app.models.subtask_context import ContextType


def _context() -> SimpleNamespace:
    return SimpleNamespace(
        id=41,
        subtask_id=0,
        user_id=7,
        context_type=ContextType.ATTACHMENT.value,
        name="reference.txt",
        status="ready",
        error_message="",
        text_length=9,
        type_data={
            "original_filename": "reference.txt",
            "file_extension": ".txt",
            "file_size": 9,
            "mime_type": "text/plain",
            "storage_backend": "mysql",
            "storage_key": "attachments/41",
        },
        created_at=None,
        original_filename="reference.txt",
        file_extension=".txt",
        file_size=9,
        mime_type="text/plain",
        storage_backend="mysql",
        storage_key="attachments/41",
        extracted_text="reference",
    )


def _request() -> Request:
    return Request(
        {
            "type": "http",
            "http_version": "1.1",
            "method": "GET",
            "scheme": "http",
            "path": "/api/attachments/41/download",
            "raw_path": b"/api/attachments/41/download",
            "query_string": b"",
            "headers": [],
            "client": ("127.0.0.1", 12345),
            "server": ("testserver", 80),
            "root_path": "",
        }
    )


@pytest.mark.asyncio
async def test_upload_read_parse_store_and_serialize_run_outside_event_loop(
    monkeypatch,
) -> None:
    entered = threading.Event()
    release = threading.Event()
    main_thread_id = threading.get_ident()
    worker_thread_ids: list[int] = []
    session = SimpleNamespace()

    class SessionContext:
        def __enter__(self):
            return session

        def __exit__(self, exc_type, exc, traceback):
            return None

    def blocking_upload(**kwargs):
        worker_thread_ids.append(threading.get_ident())
        assert kwargs["db"] is session
        assert kwargs["binary_data"] == b"reference"
        assert kwargs["user_id"] == 7
        entered.set()
        assert release.wait(timeout=1)
        return _context(), None

    monkeypatch.setattr(attachments.db_session, "SessionLocal", SessionContext)
    monkeypatch.setattr(
        attachments.context_service,
        "upload_attachment",
        blocking_upload,
    )
    upload = UploadFile(file=io.BytesIO(b"reference"), filename="reference.txt")
    task = asyncio.create_task(
        attachments.upload_attachment(
            file=upload,
            overwrite_attachment_id=None,
            storage_purpose="default",
            current_user=SimpleNamespace(id=7),
            authorization="",
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

    response = await task
    assert worker_thread_ids == [worker_thread_ids[0]]
    assert worker_thread_ids[0] != main_thread_id
    assert json.loads(response.body)["id"] == 41


@pytest.mark.asyncio
async def test_upload_hard_limit_rejects_before_opening_database(monkeypatch) -> None:
    class TrackingFile(io.BytesIO):
        def __init__(self, payload: bytes) -> None:
            super().__init__(payload)
            self.read_sizes: list[int] = []

        def read(self, size: int = -1) -> bytes:
            self.read_sizes.append(size)
            return super().read(size)

    file_object = TrackingFile(b"12345")
    monkeypatch.setattr(
        attachments.DocumentParser,
        "get_max_file_size",
        lambda: 4,
    )
    monkeypatch.setattr(
        attachments.db_session,
        "SessionLocal",
        lambda: (_ for _ in ()).throw(
            AssertionError("oversized uploads must not open a database session")
        ),
    )

    with pytest.raises(HTTPException) as exc_info:
        await attachments.upload_attachment(
            file=UploadFile(file=file_object, filename="reference.txt"),
            overwrite_attachment_id=None,
            storage_purpose="default",
            current_user=SimpleNamespace(id=7),
            authorization="",
        )

    assert exc_info.value.status_code == 400
    assert file_object.read_sizes == [5]


def test_upload_worker_owns_session_and_serializes_before_close(monkeypatch) -> None:
    session = SimpleNamespace(closed=False)

    class SessionContext:
        def __enter__(self):
            return session

        def __exit__(self, exc_type, exc, traceback):
            session.closed = True

    def upload_attachment(**kwargs):
        assert kwargs["db"] is session
        assert kwargs["binary_data"] == b"reference"
        return _context(), None

    monkeypatch.setattr(attachments.db_session, "SessionLocal", SessionContext)
    monkeypatch.setattr(
        attachments.context_service,
        "upload_attachment",
        upload_attachment,
    )

    response = attachments._upload_attachment_sync(
        io.BytesIO(b"reference"),
        user_id=7,
        filename="reference.txt",
        overwrite_attachment_id=None,
        subtask_id=0,
        storage_purpose="default",
    )

    assert session.closed is True
    assert json.loads(response.body)["filename"] == "reference.txt"


@pytest.mark.asyncio
async def test_download_authorization_does_not_block_event_loop(monkeypatch) -> None:
    entered = threading.Event()
    release = threading.Event()
    main_thread_id = threading.get_ident()
    worker_thread_ids: list[int] = []

    def blocking_authorize(*args):
        worker_thread_ids.append(threading.get_ident())
        entered.set()
        assert release.wait(timeout=1)
        return SimpleNamespace(id=41, type_data={})

    async def no_external(context, *, range_header=None):
        return None

    async def stored_response(context):
        return Response(b"reference")

    monkeypatch.setattr(
        attachments,
        "_attachment_stream_snapshot_sync",
        blocking_authorize,
    )
    monkeypatch.setattr(attachments, "_stream_external_attachment", no_external)
    monkeypatch.setattr(attachments, "_stream_stored_attachment", stored_response)
    task = asyncio.create_task(
        attachments.download_attachment(
            attachment_id=41,
            request=_request(),
            share_token=None,
            download_token=None,
            range_header=None,
            current_user=SimpleNamespace(id=7, user_name="user-7"),
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

    response = await task
    assert worker_thread_ids[0] != main_thread_id
    assert response.body == b"reference"


def test_download_worker_owns_session_and_returns_deep_snapshot(monkeypatch) -> None:
    session = SimpleNamespace(closed=False)
    context = _context()

    class SessionContext:
        def __enter__(self):
            return session

        def __exit__(self, exc_type, exc, traceback):
            session.closed = True

    def get_context(
        db,
        attachment_id,
        current_user,
        *,
        include_extracted_text=False,
    ):
        assert db is session
        assert attachment_id == 41
        assert current_user.id == 7
        assert include_extracted_text is False
        return context

    monkeypatch.setattr(attachments.db_session, "SessionLocal", SessionContext)
    monkeypatch.setattr(attachments, "_get_attachment_context", get_context)

    snapshot = attachments._attachment_stream_snapshot_sync(
        41,
        attachments._UserIdentity(id=7, user_name="user-7"),
        None,
        None,
    )
    context.type_data["storage_key"] = "changed"

    assert session.closed is True
    assert snapshot.storage_key == "attachments/41"
    assert snapshot.type_data["storage_key"] == "attachments/41"


@pytest.mark.asyncio
async def test_upload_executor_rejects_when_finite_admission_is_full(
    monkeypatch,
) -> None:
    entered = threading.Event()
    release = threading.Event()
    executor = BoundedExecutor(
        max_workers=1,
        max_in_flight=1,
        max_waiters=0,
        thread_name_prefix="test-attachment-overload",
    )

    def blocking_upload(*args, **kwargs):
        entered.set()
        assert release.wait(timeout=1)
        return Response(b"{}", media_type="application/json")

    monkeypatch.setattr(attachments, "_ATTACHMENT_UPLOAD_EXECUTOR", executor)
    monkeypatch.setattr(attachments, "_upload_attachment_sync", blocking_upload)
    first = asyncio.create_task(
        attachments.upload_attachment(
            file=UploadFile(file=io.BytesIO(b"one"), filename="one.txt"),
            overwrite_attachment_id=None,
            storage_purpose="default",
            current_user=SimpleNamespace(id=7),
            authorization="",
        )
    )

    try:
        assert await asyncio.to_thread(entered.wait, 1)
        with pytest.raises(BoundedExecutorOverloaded):
            await attachments.upload_attachment(
                file=UploadFile(file=io.BytesIO(b"two"), filename="two.txt"),
                overwrite_attachment_id=None,
                storage_purpose="default",
                current_user=SimpleNamespace(id=7),
                authorization="",
            )
    finally:
        release.set()

    await first


@pytest.mark.asyncio
async def test_stored_download_holds_admission_until_stream_finishes(
    monkeypatch,
) -> None:
    monkeypatch.setattr(
        attachments,
        "_STORED_DOWNLOAD_ADMISSION",
        attachments._StoredDownloadAdmission(max_active=1),
    )
    monkeypatch.setattr(
        attachments,
        "_load_stored_attachment_binary_data",
        lambda attachment_id: b"reference",
    )
    context = _context()

    first = await attachments._stream_stored_attachment(context)
    with pytest.raises(BoundedExecutorOverloaded):
        await attachments._stream_stored_attachment(context)

    assert (
        b"".join([bytes(chunk) async for chunk in first.body_iterator]) == b"reference"
    )
    third = await attachments._stream_stored_attachment(context)
    assert (
        b"".join([bytes(chunk) async for chunk in third.body_iterator]) == b"reference"
    )


@pytest.mark.asyncio
async def test_cancelled_stored_download_releases_admission_after_load(
    monkeypatch,
) -> None:
    entered = threading.Event()
    release = threading.Event()
    monkeypatch.setattr(
        attachments,
        "_STORED_DOWNLOAD_ADMISSION",
        attachments._StoredDownloadAdmission(max_active=1),
    )

    def blocking_load(attachment_id: int) -> bytes:
        entered.set()
        assert release.wait(timeout=1)
        return b"reference"

    monkeypatch.setattr(
        attachments,
        "_load_stored_attachment_binary_data",
        blocking_load,
    )
    first = asyncio.create_task(attachments._stream_stored_attachment(_context()))

    assert await asyncio.to_thread(entered.wait, 1)
    first.cancel()
    with pytest.raises(asyncio.CancelledError):
        await first
    with pytest.raises(BoundedExecutorOverloaded):
        await attachments._stream_stored_attachment(_context())

    release.set()
    for _ in range(100):
        await asyncio.sleep(0.01)
        try:
            response = await attachments._stream_stored_attachment(_context())
        except BoundedExecutorOverloaded:
            continue
        break
    else:
        pytest.fail("cancelled download did not release its retained-buffer slot")

    assert (
        b"".join([bytes(chunk) async for chunk in response.body_iterator])
        == b"reference"
    )
