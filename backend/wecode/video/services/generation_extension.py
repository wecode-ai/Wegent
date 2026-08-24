# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Internal video-generation storage and provider adaptation."""

import logging
from typing import Any, Optional

from sqlalchemy.orm import Session

from app.db.session import SessionLocal
from app.models.subtask_context import ContextStatus, SubtaskContext
from app.services.attachment.external_storage import (
    ExternalAttachmentPlayback,
    ExternalAttachmentStorageResult,
    register_external_attachment_playback_resolver,
    register_external_attachment_storage_adapter,
)
from app.services.execution.agents.video.extensions import (
    PreparedVideoArtifact,
    VideoResultOverride,
    VideoStatusOverride,
    register_video_generation_extension,
)
from wecode.video.config.media import video_media_settings
from wecode.video.services.media_platform import (
    fetch_playback,
    sign_urls,
    upload_media,
)

logger = logging.getLogger(__name__)


class WeiboMediaAttachmentStorageAdapter:
    """Store uploaded video and audio on the Weibo media platform."""

    @property
    def backend_type(self) -> str:
        return "weibo_media_hosting"

    def supports(self, mime_type: str, purpose: str) -> bool:
        return (
            purpose in {"default", "video_reference"}
            and video_media_settings.storage_enabled
            and mime_type.startswith(("video/", "audio/"))
        )

    def store(
        self,
        *,
        db: Session,
        user_id: int,
        filename: str,
        mime_type: str,
        data: bytes,
    ) -> ExternalAttachmentStorageResult:
        media_type = "audio" if mime_type.startswith("audio/") else "video"
        uploaded = upload_media(
            data=data,
            filename=filename,
            uid=video_media_settings.get_upload_uid(),
            media_type=media_type,
        )
        backend_type = f"weibo_{media_type}_hosting"
        metadata_key = f"weibo_{media_type}_upload"
        return ExternalAttachmentStorageResult(
            backend_type=backend_type,
            type_data={
                metadata_key: {
                    "media_id": uploaded.media_id,
                    "upload_id": uploaded.upload_id,
                }
            },
        )


class WeiboMediaAttachmentPlaybackResolver:
    """Resolve Weibo-hosted video and audio attachments for browser playback."""

    def resolve_playback(
        self,
        *,
        type_data: dict[str, Any],
        user_id: int,
    ) -> Optional[ExternalAttachmentPlayback]:
        media_type, media_id = _stored_media_reference(type_data)
        if not media_type or not media_id:
            return None

        del user_id
        uid = _media_uid()
        playback = fetch_playback([media_id], uid).get(media_id)
        if playback is None or not playback.url:
            raise ValueError(
                f"Weibo {media_type} playback URL is unavailable for media_id={media_id}"
            )
        return ExternalAttachmentPlayback(
            url=_https(playback.url),
            media_type="audio/mpeg" if media_type == "audio" else "video/mp4",
        )


class WeiboVideoGenerationExtension:
    """Adapt video generation to Weibo media identifiers and playback URLs."""

    def resolve_material(
        self,
        *,
        type_data: dict[str, Any],
        media_type: str,
    ) -> Optional[dict[str, Any]]:
        upload = type_data.get(f"weibo_{media_type}_upload") or {}
        media_id = upload.get("media_id")
        if not media_id:
            return None
        return {"external_reference": {"id": str(media_id)}}

    def build_provider_content(
        self,
        *,
        protocol: str,
        media_type: str,
        descriptor: dict[str, Any],
        role: str,
    ) -> Optional[dict[str, Any]]:
        if protocol != "seedance":
            return None
        reference = descriptor.get("external_reference") or {}
        media_id = reference.get("id")
        if not media_id or media_type not in {"video", "audio"}:
            return None
        return {
            "type": f"{media_type}_media_id",
            f"{media_type}_media_id": str(media_id),
            "role": role,
        }

    def parse_status(
        self,
        response: dict[str, Any],
        fallback: VideoStatusOverride,
    ) -> Optional[VideoStatusOverride]:
        wb_data = response.get("wb_data")
        if not isinstance(wb_data, dict) or not wb_data:
            return None
        status = str(wb_data.get("status") or "")
        raw_progress = wb_data.get(
            "progress", wb_data.get("process", fallback.progress)
        )
        progress = (
            int(raw_progress)
            if isinstance(raw_progress, (int, float))
            else fallback.progress
        )
        is_completed = status == "succeeded" if status else fallback.is_completed
        is_failed = status == "failed" if status else fallback.is_failed
        if fallback.is_failed and not is_completed:
            is_failed = True
        return VideoStatusOverride(
            progress=max(0, min(progress, 100)),
            is_completed=is_completed,
            is_failed=is_failed,
            error=fallback.error or wb_data.get("error_message"),
        )

    def parse_result(
        self,
        response: dict[str, Any],
        fallback: VideoResultOverride,
    ) -> Optional[VideoResultOverride]:
        wb_data = response.get("wb_data")
        if not isinstance(wb_data, dict) or not wb_data:
            return None
        return VideoResultOverride(
            video_url=wb_data.get("video_url") or fallback.video_url,
            thumbnail=fallback.thumbnail,
            duration=fallback.duration,
            metadata={
                "weibo_hosted": True,
                **{
                    key: wb_data.get(key)
                    for key in ("media_id", "pid", "fid", "cover_url")
                    if wb_data.get(key) is not None
                },
            },
        )

    def prepare_result(
        self,
        *,
        result: Any,
        user_id: int,
        task_id: int,
        subtask_id: int,
    ) -> Optional[PreparedVideoArtifact]:
        metadata = result.metadata or {}
        if not metadata.get("weibo_hosted"):
            return None

        video_media_settings.validate_playback_config()
        media_id = str(metadata.get("media_id") or "").strip()
        if not media_id:
            raise ValueError("Weibo-hosted video result is missing media_id")

        db = SessionLocal()
        try:
            uid = _media_uid()
            playback = fetch_playback([media_id], uid, sign=False).get(media_id)
            if playback is None or not playback.url:
                raise ValueError("Weibo-hosted video has no original media URL")
            raw_url = playback.url
            signed_url = sign_urls([raw_url], uid).get(raw_url) or raw_url
            cover_url = (
                playback.cover_url
                if playback is not None and playback.cover_url
                else metadata.get("cover_url")
            )
            thumbnail = result.thumbnail
            duration = (
                playback.duration
                if playback is not None and playback.duration is not None
                else result.duration
            )
            attachment = self._create_generated_attachment(
                db=db,
                user_id=user_id,
                task_id=task_id,
                subtask_id=subtask_id,
                raw_url=raw_url,
                thumbnail=thumbnail,
                duration=duration,
                size=playback.size if playback is not None else None,
                metadata=metadata,
                cover_url=cover_url,
            )
            return PreparedVideoArtifact(
                video_url=raw_url,
                websocket_video_url=_https(signed_url),
                attachment_id=attachment.id,
                thumbnail=thumbnail,
                duration=duration,
                block_metadata={
                    **{
                        key: metadata.get(key)
                        for key in ("media_id", "pid", "fid")
                        if metadata.get(key) is not None
                    },
                    **({"cover_url": _https(cover_url)} if cover_url else {}),
                },
            )
        finally:
            db.close()

    def refresh_result_urls(
        self,
        *,
        task: dict[str, Any],
        user_id: int,
    ) -> None:
        blocks = _video_blocks(task)
        media_ids = list(
            dict.fromkeys(
                str(block.get("media_id")) for block in blocks if block.get("media_id")
            )
        )
        if not media_ids:
            return
        del user_id
        uid = _media_uid()
        raw_urls = list(
            dict.fromkeys(
                str(block.get("video_url"))
                for block in blocks
                if block.get("media_id") and block.get("video_url")
            )
        )
        try:
            signed_urls = sign_urls(raw_urls, uid)
        except Exception:
            logger.warning("Failed to refresh Weibo playback URLs", exc_info=True)
            return
        for block in blocks:
            raw_url = str(block.get("video_url") or "")
            signed_url = signed_urls.get(raw_url)
            if signed_url:
                block["video_url"] = _https(signed_url)

    @staticmethod
    def _create_generated_attachment(
        *,
        db: Session,
        user_id: int,
        task_id: int,
        subtask_id: int,
        raw_url: str,
        thumbnail: Optional[str],
        duration: Optional[float],
        size: Optional[int],
        metadata: dict[str, Any],
        cover_url: Optional[str],
    ) -> SubtaskContext:
        media_id = str(metadata["media_id"])
        attachment = SubtaskContext(
            subtask_id=subtask_id,
            user_id=user_id,
            context_type="attachment",
            name=f"video_{task_id}_{subtask_id}.mp4",
            status=ContextStatus.READY.value,
            binary_data=b"",
            image_base64="",
            extracted_text="",
            text_length=0,
            error_message="",
            type_data={
                "original_filename": f"video_{task_id}_{subtask_id}.mp4",
                "file_extension": ".mp4",
                "file_size": size or 0,
                "mime_type": "video/mp4",
                "storage_backend": "weibo_video_hosting",
                "storage_key": "",
                "is_encrypted": False,
                "encryption_version": 0,
                "weibo_video_upload": {
                    "media_id": media_id,
                    "upload_id": "",
                    "fid": metadata.get("fid"),
                },
                "video_metadata": {
                    "video_url": raw_url,
                    "thumbnail": thumbnail,
                    "cover_url": cover_url,
                    "duration": duration,
                    "media_id": media_id,
                    "pid": metadata.get("pid"),
                    "fid": metadata.get("fid"),
                },
            },
        )
        db.add(attachment)
        db.commit()
        db.refresh(attachment)
        return attachment


def _video_blocks(task: dict[str, Any]) -> list[dict[str, Any]]:
    blocks: list[dict[str, Any]] = []
    result = task.get("result")
    if isinstance(result, dict):
        blocks.extend(
            block
            for block in result.get("blocks") or []
            if isinstance(block, dict) and block.get("type") == "video"
        )
    for subtask in task.get("subtasks") or []:
        subtask_result = subtask.get("result") if isinstance(subtask, dict) else None
        if isinstance(subtask_result, dict):
            blocks.extend(
                block
                for block in subtask_result.get("blocks") or []
                if isinstance(block, dict) and block.get("type") == "video"
            )
    return blocks


def _media_uid() -> str:
    return video_media_settings.get_upload_uid()


def _stored_media_reference(type_data: dict[str, Any]) -> tuple[str, str]:
    """Return the Weibo media type and ID persisted on an attachment."""
    for media_type in ("video", "audio"):
        upload = type_data.get(f"weibo_{media_type}_upload")
        if isinstance(upload, dict) and upload.get("media_id"):
            return media_type, str(upload["media_id"])

    video_metadata = type_data.get("video_metadata")
    if isinstance(video_metadata, dict) and video_metadata.get("media_id"):
        return "video", str(video_metadata["media_id"])
    return "", ""


def _https(url: str) -> str:
    return f"https://{url[len('http://'):]}" if url.startswith("http://") else url


register_external_attachment_storage_adapter(WeiboMediaAttachmentStorageAdapter())
register_external_attachment_playback_resolver(WeiboMediaAttachmentPlaybackResolver())
register_video_generation_extension(WeiboVideoGenerationExtension())
