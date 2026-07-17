# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0
"""Weibo VideoUploadProvider — two-phase KB video upload backed by Weibo file platform.

Implements the open-source ``VideoUploadProvider`` Protocol so KB video
uploads flow through the framework's ``/knowledge-documents/attachments/video-upload/{init,complete}``
endpoints instead of the generic 100 MB ``/attachments/upload`` path.

Phase 1 (init_upload):
    The backend calls Weibo's ``init.json`` (via ``weibo_media_service.init_upload``)
    to open a chunked upload session. The returned ``file_token`` + ``X-Up-Auth``
    are handed to the frontend through ``VideoUploadTarget.extra`` so the
    frontend can stream chunks directly to Weibo's ``upload.json`` — the binary
    never enters backend memory. ``file_hash`` (md5 of the full file, computed
    client-side) is forwarded as Weibo's ``check`` parameter.

Phase 2 (complete_upload):
    After the frontend's last chunk returns a ``fid``, the frontend calls
    ``complete`` with ``upload_result={"fid": ...}``. The backend persists only
    metadata (fid + ``storage_backend="weibo"``) on the attachment via
    ``context_service.upload_video_metadata`` — no binary.

Auto-registers itself on import via ``register_video_upload_provider``.
"""

from __future__ import annotations

import asyncio
import concurrent.futures
import logging
from typing import Any, Dict

from app.db.session import SessionLocal
from app.models.user import User
from app.services.context import context_service
from app.services.knowledge.video_upload_provider import (
    VideoUploadCompleteResult,
    VideoUploadTarget,
    register_video_upload_provider,
)
from app.services.media.weibo_media_service import WEIBO_UPLOAD_URL, weibo_media_service

logger = logging.getLogger(__name__)

# KB video attachments are not bound to a subtask; they are linked to a
# knowledge document on upload. Using 0 as the sentinel keeps the context
# service happy without reserving a real subtask id.
_UNLINKED_SUBTASK_ID = 0


def _run_async(coro):
    """Run an async coroutine from a sync context, handling event loop edge cases.

    The open-source VideoUploadProvider Protocol defines init_upload /
    complete_upload as sync methods, but weibo_media_service.init_upload is
    async. We bridge them here rather than in the Protocol. ``asyncio.run()``
    would fail if a loop is already running (e.g. when called via
    ``run_in_threadpool``); this helper detects that and falls back to running
    in a dedicated thread.
    """
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        # No running loop — safe to use asyncio.run directly.
        return asyncio.run(coro)

    # A loop is already running (e.g. inside an async FastAPI route). Run the
    # coroutine in a fresh thread so we don't nest event loops.
    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
        return pool.submit(asyncio.run, coro).result()


class WeiboVideoUploadProvider:
    """Two-phase VideoUploadProvider backed by the Weibo file platform."""

    def init_upload(
        self,
        *,
        filename: str,
        file_size: int,
        file_extension: str,
        uploader: User,
        file_hash: str = "",
    ) -> VideoUploadTarget:
        init_result = _run_async(
            weibo_media_service.init_upload(
                filename=filename,
                file_size=file_size,
                file_check=file_hash,
                user=uploader,
            )
        )
        # Frontend POSTs each chunk to WEIBO_UPLOAD_URL with these params.
        return VideoUploadTarget(
            upload_url=WEIBO_UPLOAD_URL,
            method="POST",
            headers={
                "Content-Type": "application/octet-stream",
                "X-Up-Auth": init_result.auth,
            },
            extra={
                "file_token": init_result.file_token,
                "chunk_size": init_result.chunk_size,
                "request_id": init_result.request_id,
                "filelength": file_size,
                "filecheck": file_hash,
            },
        )

    def complete_upload(
        self,
        *,
        upload_result: Dict[str, Any],
        filename: str,
        file_size: int,
        file_extension: str,
        uploader: User,
    ) -> VideoUploadCompleteResult:
        fid_raw = upload_result.get("fid")
        if fid_raw is None:
            raise ValueError("Weibo complete_upload requires upload_result['fid']")
        fid = int(fid_raw)

        extension = file_extension.lower()
        if extension and not extension.startswith("."):
            extension = f".{extension}"

        db = SessionLocal()
        try:
            context = context_service.upload_video_metadata(
                db=db,
                user_id=uploader.id,
                filename=filename,
                file_size=file_size,
                extension=extension,
                fid=fid,
                subtask_id=_UNLINKED_SUBTASK_ID,
            )
        finally:
            db.close()

        logger.info(
            "[WeiboVideoUploadProvider] complete_upload attachment_id=%s fid=%s",
            context.id,
            fid,
        )
        return VideoUploadCompleteResult(
            attachment_id=context.id,
            storage_backend="weibo",
            object_key=str(fid),
        )


register_video_upload_provider(WeiboVideoUploadProvider())
logger.info("[wecode] WeiboVideoUploadProvider registered")
