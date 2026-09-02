# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import asyncio
import io
import threading
from types import SimpleNamespace

import pytest
from fastapi import HTTPException, UploadFile

from app.api.endpoints import attachments_open
from app.core.security import AuthContext
from app.schemas.subtask_context import AttachmentResponse


def _attachment_response() -> AttachmentResponse:
    return AttachmentResponse(
        id=41,
        filename="reference.txt",
        file_size=9,
        mime_type="text/plain",
        status="ready",
        text_length=9,
    )


@pytest.mark.asyncio
async def test_upload_attachment_does_not_block_event_loop(monkeypatch):
    entered = threading.Event()
    release = threading.Event()

    def blocking_upload(file_object, user_id, filename):
        assert file_object.read() == b"reference"
        assert user_id == 7
        assert filename == "reference.txt"
        entered.set()
        assert release.wait(timeout=1)
        return _attachment_response()

    monkeypatch.setattr(
        attachments_open,
        "_read_and_store_attachment",
        blocking_upload,
    )
    upload = UploadFile(
        file=io.BytesIO(b"reference"),
        filename="reference.txt",
    )
    task = asyncio.create_task(
        attachments_open.upload_attachment_open(
            file=upload,
            auth_context=AuthContext(user=SimpleNamespace(id=7)),
        )
    )

    try:
        for _ in range(100):
            if entered.is_set():
                break
            await asyncio.sleep(0.001)
        assert entered.is_set()

        loop_tick = asyncio.Event()
        asyncio.get_running_loop().call_soon(loop_tick.set)
        await asyncio.wait_for(loop_tick.wait(), timeout=0.1)
        assert not task.done()
    finally:
        release.set()

    assert await task == _attachment_response()


def test_read_and_store_attachment_owns_fresh_session(monkeypatch):
    worker_thread_id = threading.get_ident()
    session = SimpleNamespace(closed=False)

    class SessionContext:
        def __enter__(self):
            return session

        def __exit__(self, exc_type, exc, traceback):
            session.closed = True

    def upload_attachment(**kwargs):
        assert threading.get_ident() == worker_thread_id
        assert kwargs == {
            "db": session,
            "user_id": 7,
            "filename": "reference.txt",
            "binary_data": b"reference",
            "subtask_id": attachments_open.UNLINKED_SUBTASK_ID,
        }
        return (
            SimpleNamespace(
                id=41,
                name="reference.txt",
                type_data={
                    "original_filename": "reference.txt",
                    "file_size": 9,
                    "mime_type": "text/plain",
                },
                status="ready",
                text_length=9,
                error_message=None,
                created_at=None,
            ),
            None,
        )

    monkeypatch.setattr(attachments_open, "SessionLocal", SessionContext)
    monkeypatch.setattr(
        attachments_open.context_service,
        "upload_attachment",
        upload_attachment,
    )

    response = attachments_open._read_and_store_attachment(
        io.BytesIO(b"reference"),
        7,
        "reference.txt",
    )

    assert response == _attachment_response()
    assert session.closed is True


def test_read_and_store_attachment_rejects_oversized_file_before_db(monkeypatch):
    monkeypatch.setattr(
        attachments_open.DocumentParser,
        "get_max_file_size",
        lambda: 4,
    )
    session_local_called = False

    def session_local():
        nonlocal session_local_called
        session_local_called = True
        raise AssertionError("oversized uploads must not open a database session")

    monkeypatch.setattr(attachments_open, "SessionLocal", session_local)

    with pytest.raises(HTTPException) as exc_info:
        attachments_open._read_and_store_attachment(
            io.BytesIO(b"oversized"),
            7,
            "reference.txt",
        )

    assert exc_info.value.status_code == 400
    assert session_local_called is False
