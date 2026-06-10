# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""External web content crawling and normalization."""

from __future__ import annotations

import asyncio
import json
import logging
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlparse

import httpx
from fastapi import HTTPException, status
from fastapi.encoders import jsonable_encoder
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.subtask_context import SubtaskContext
from app.models.user import User
from app.services.attachment.parser import DocumentParser
from app.services.context import context_service
from app.services.media.weibo_media_service import weibo_media_service

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class ExternalWebContentPreview:
    """Normalized context data built from spider MCP result."""

    name: str
    source_url: str
    type_data: dict[str, Any]

    @property
    def video_count(self) -> int:
        return len(self.type_data.get("videos") or [])

    @property
    def site(self) -> str | None:
        normalized = self.type_data.get("normalized") or {}
        return normalized.get("site")

    @property
    def cover_url(self) -> str | None:
        for asset in self.type_data.get("videos") or []:
            if isinstance(asset, dict) and asset.get("cover_url"):
                return asset["cover_url"]
        return None


class WebContentCrawlError(Exception):
    """Raised when external web content crawling fails."""


class WebContentService:
    """Fetch and normalize external web video content through spider MCP."""

    async def crawl(self, url: str) -> ExternalWebContentPreview:
        source_url = self._validate_source_url(url)
        logger.info(
            "[WEB_CONTENT_MCP] crawl_start url=%s mcp_url=%s tool=%s",
            source_url,
            settings.WEB_CONTENT_MCP_URL,
            settings.WEB_CONTENT_CRAWL_TOOL,
        )
        raw_data = await self._crawl_with_fastmcp(source_url)
        return self._build_preview(source_url, raw_data)

    async def create_context(
        self,
        db: Session,
        *,
        user: User,
        preview: ExternalWebContentPreview,
    ) -> list[SubtaskContext]:
        """Persist crawled external web videos as ordinary Weibo video attachments."""
        contexts: list[SubtaskContext] = []
        try:
            videos = preview.type_data.get("videos") or []
            for index, video in enumerate(videos, start=1):
                if not isinstance(video, dict):
                    continue
                context = await self._create_video_attachment_from_asset(
                    user=user,
                    preview=preview,
                    video=video,
                    index=index,
                    total=len(videos),
                )
                db.add(context)
                contexts.append(context)

            if not contexts:
                raise HTTPException(
                    status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                    detail="No video_url_s3 found in external web content result",
                )

            db.commit()
            for context in contexts:
                db.refresh(context)
            return contexts
        except Exception:
            db.rollback()
            raise

    async def _crawl_with_fastmcp(self, url: str) -> Any:
        try:
            from fastmcp import Client
        except ImportError as exc:
            raise WebContentCrawlError("fastmcp is not installed") from exc

        try:
            async with Client(settings.WEB_CONTENT_MCP_URL) as client:
                logger.info(
                    "[WEB_CONTENT_MCP] call_tool request tool=%s arguments=%s",
                    settings.WEB_CONTENT_CRAWL_TOOL,
                    self._serialize_for_log({"url": url}),
                )
                task = await client.call_tool(
                    settings.WEB_CONTENT_CRAWL_TOOL,
                    {"url": url},
                    task=True,
                )
                task_id = getattr(task, "task_id", None) or getattr(task, "id", None)
                logger.info(
                    "[WEB_CONTENT_MCP] call_tool response task_id=%s task=%s",
                    task_id,
                    self._serialize_for_log(task),
                )
                await self._wait_task_done(client, task)
                result = await task.result()
                logger.info(
                    "[WEB_CONTENT_MCP] task_result raw_result=%s",
                    self._serialize_for_log(result),
                )
        except Exception as exc:
            logger.exception("Failed to crawl external web content: url=%s", url)
            raise WebContentCrawlError(str(exc)) from exc

        raw_data = self._extract_business_data(result)
        logger.info(
            "[WEB_CONTENT_MCP] extracted_business_data raw_data=%s",
            self._serialize_for_log(raw_data),
        )
        return raw_data

    async def _wait_task_done(self, client: Any, task: Any) -> None:
        timeout_seconds = settings.WEB_CONTENT_CRAWL_TIMEOUT_SECONDS
        deadline = asyncio.get_running_loop().time() + timeout_seconds
        task_id = getattr(task, "task_id", None) or getattr(task, "id", None)
        if not task_id:
            raise WebContentCrawlError("External web content crawl task id is missing")

        while True:
            if asyncio.get_running_loop().time() >= deadline:
                raise WebContentCrawlError("External web content crawl timed out")

            status_obj = await client.get_task_status(task_id)
            status_value = self._read_status_value(status_obj)
            logger.info(
                "[WEB_CONTENT_MCP] task_status task_id=%s status=%s status_obj=%s",
                task_id,
                status_value,
                self._serialize_for_log(status_obj),
            )
            if status_value in {"completed", "succeeded", "success", "done"}:
                return
            if status_value in {"failed", "error", "cancelled", "canceled"}:
                message = self._read_status_message(status_obj)
                raise WebContentCrawlError(
                    message or "External web content crawl failed"
                )

            poll_interval = self._read_poll_interval(status_obj)
            await asyncio.sleep(poll_interval)

    def _extract_business_data(self, result: Any) -> Any:
        data = self._get_attr_or_key(result, "data")
        if data is not None:
            return self._parse_json_if_needed(data)

        structured_content = self._get_attr_or_key(result, "structured_content")
        if structured_content is None:
            structured_content = self._get_attr_or_key(result, "structuredContent")

        if isinstance(structured_content, dict):
            for key in ("result", "data"):
                if key in structured_content:
                    return self._parse_json_if_needed(structured_content[key])

        if hasattr(result, "model_dump"):
            dumped = result.model_dump(mode="json")
            return self._extract_business_data(dumped)

        return self._parse_json_if_needed(result)

    def _build_preview(
        self,
        source_url: str,
        raw_data: Any,
        *,
        crawl_tool: str | None = None,
    ) -> ExternalWebContentPreview:
        items = self._as_items(raw_data)
        videos = self._extract_videos(items)
        logger.info(
            "[WEB_CONTENT_MCP] normalize_result url=%s raw_type=%s item_count=%s "
            "item_keys=%s video_count=%s",
            source_url,
            type(raw_data).__name__,
            len(items),
            [sorted(item.keys()) for item in items[:5]],
            len(videos),
        )
        if not videos:
            logger.warning(
                "[WEB_CONTENT_MCP] no_video_url_s3 url=%s raw_data=%s",
                source_url,
                self._serialize_for_log(raw_data),
            )
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="No video_url_s3 found in external web content result",
            )

        max_videos = settings.WEB_CONTENT_MAX_VIDEOS_PER_CONTEXT
        if len(videos) > max_videos:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=f"External web content contains more than {max_videos} videos",
            )

        primary_item = self._find_primary_item(items, videos[0])
        normalized = self._normalize_item(primary_item)
        name = normalized.get("title") or self._build_fallback_name(source_url)

        type_data = {
            "source": "external_web_content",
            "source_url": source_url,
            "crawl_tool": crawl_tool or settings.WEB_CONTENT_CRAWL_TOOL,
            "normalized": normalized,
            "videos": videos,
            "raw_result": raw_data,
        }
        return ExternalWebContentPreview(
            name=name, source_url=source_url, type_data=type_data
        )

    async def _create_video_attachment_from_asset(
        self,
        *,
        user: User,
        preview: ExternalWebContentPreview,
        video: dict[str, Any],
        index: int,
        total: int,
    ) -> SubtaskContext:
        video_url = video.get("url")
        if not isinstance(video_url, str) or not video_url.strip():
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="No video_url_s3 found in external web content result",
            )

        filename = self._build_reference_filename(preview.name, index, total)
        content = await self._download_video(video_url.strip())
        upload_result = await weibo_media_service.upload_video_bytes(
            filename=filename,
            content=content,
            user=user,
        )
        logger.info(
            "[WEB_CONTENT_VIDEO] uploaded_to_weibo source_url=%s asset_id=%s "
            "filename=%s size=%s fid=%s",
            preview.source_url,
            video.get("asset_id"),
            filename,
            len(content),
            upload_result.fid,
        )

        return context_service.create_video_metadata_context(
            user_id=user.id,
            filename=filename,
            file_size=len(content),
            extension=".mp4",
            fid=upload_result.fid,
            subtask_id=0,
            extra_type_data={
                "source": "external_web_content",
                "external_source_url": preview.source_url,
                "raw_result": preview.type_data.get("raw_result"),
                "external_video_index": index - 1,
            },
        )

    async def _download_video(self, video_url: str) -> bytes:
        max_size = DocumentParser.get_max_video_file_size()
        try:
            async with httpx.AsyncClient(
                timeout=httpx.Timeout(connect=15.0, read=180.0, write=30.0, pool=30.0),
                follow_redirects=True,
            ) as client:
                response = await client.get(video_url)
        except httpx.TimeoutException as exc:
            raise WebContentCrawlError("External web video download timed out") from exc
        except httpx.HTTPError as exc:
            raise WebContentCrawlError(
                f"External web video download failed: {exc}"
            ) from exc

        if response.status_code >= 400:
            raise WebContentCrawlError(
                f"External web video download failed with status {response.status_code}"
            )

        content_length = response.headers.get("content-length")
        if content_length:
            try:
                declared_size = int(content_length)
            except ValueError:
                declared_size = 0
            if declared_size > max_size:
                raise HTTPException(
                    status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                    detail="External web video file size exceeds maximum limit",
                )

        # This intentionally keeps the current buffered download behavior.
        # If the upstream response omits Content-Length, large videos are only rejected
        # after httpx has read the body into memory.
        content = response.content
        if not content:
            raise WebContentCrawlError(
                "External web video download returned empty body"
            )
        if len(content) > max_size:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="External web video file size exceeds maximum limit",
            )

        logger.info(
            "[WEB_CONTENT_VIDEO] downloaded url_host=%s size=%s content_type=%s",
            urlparse(video_url).netloc,
            len(content),
            response.headers.get("content-type"),
        )
        return content

    def _build_reference_filename(
        self, name: str, index: int = 1, total: int = 1
    ) -> str:
        safe_name = "".join(
            ch if ch.isalnum() or ch in {" ", "-", "_"} else "_" for ch in name
        ).strip()
        if not safe_name:
            safe_name = "external-web-video"
        suffix = f"-{index}" if total > 1 else ""
        return f"{safe_name[:120]}{suffix}.mp4"

    def _extract_videos(self, items: list[dict[str, Any]]) -> list[dict[str, Any]]:
        videos: list[dict[str, Any]] = []
        seen_urls: set[str] = set()
        for item in items:
            video_url = item.get("video_url_s3")
            if not isinstance(video_url, str) or not video_url.strip():
                continue
            video_url = video_url.strip()
            if video_url in seen_urls:
                continue
            seen_urls.add(video_url)
            video_index = len(videos) + 1
            videos.append(
                {
                    "asset_id": f"web-video-{video_index}",
                    "role": "primary" if video_index == 1 else "secondary",
                    "url": video_url,
                    "original_url": item.get("video_url"),
                    "cover_url": item.get("cover_s3") or item.get("cover"),
                    "original_cover_url": item.get("cover"),
                    "mime_type": item.get("mime_type") or "video/mp4",
                    "duration": item.get("duration"),
                    "source_item_id": item.get("id") or item.get("article_id"),
                }
            )
        return videos

    def _normalize_item(self, item: dict[str, Any] | None) -> dict[str, Any]:
        item = item or {}
        return {
            "primary_item_id": item.get("id") or item.get("article_id"),
            "article_id": item.get("article_id"),
            "site": item.get("site"),
            "title": item.get("title"),
            "desc": item.get("desc"),
            "content": item.get("content"),
            "author_name": item.get("user_name") or item.get("author_name"),
            "author_id": item.get("user_id") or item.get("author_id"),
            "publish_time": item.get("pub_time") or item.get("publish_time"),
        }

    def _find_primary_item(
        self,
        items: list[dict[str, Any]],
        first_asset: dict[str, Any],
    ) -> dict[str, Any] | None:
        source_item_id = first_asset.get("source_item_id")
        for item in items:
            item_id = item.get("id") or item.get("article_id")
            if source_item_id and item_id == source_item_id:
                return item
        return items[0] if items else None

    def _as_items(self, raw_data: Any) -> list[dict[str, Any]]:
        if isinstance(raw_data, list):
            return [item for item in raw_data if isinstance(item, dict)]
        if isinstance(raw_data, dict):
            for key in ("items", "list", "videos", "data"):
                nested = raw_data.get(key)
                if isinstance(nested, list):
                    return [item for item in nested if isinstance(item, dict)]
            return [raw_data]
        return []

    def _validate_source_url(self, url: str) -> str:
        normalized_url = (url or "").strip()
        parsed = urlparse(normalized_url)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="External web content URL must be an absolute HTTP(S) URL",
            )
        return normalized_url

    def _parse_json_if_needed(self, value: Any) -> Any:
        if isinstance(value, str):
            stripped = value.strip()
            if not stripped:
                return value
            try:
                return json.loads(stripped)
            except json.JSONDecodeError:
                return value
        return value

    def _serialize_for_log(self, value: Any) -> str:
        try:
            return json.dumps(
                jsonable_encoder(value),
                ensure_ascii=False,
                default=str,
            )
        except Exception:
            return str(value)

    def _build_fallback_name(self, url: str) -> str:
        parsed = urlparse(url)
        return parsed.netloc or "External Web Content"

    def _read_status_value(self, status_obj: Any) -> str:
        value = self._get_attr_or_key(status_obj, "status")
        if hasattr(value, "value"):
            value = value.value
        return str(value or "").strip().lower()

    def _read_status_message(self, status_obj: Any) -> str | None:
        for key in ("message", "error", "error_message", "detail"):
            value = self._get_attr_or_key(status_obj, key)
            if value:
                return str(value)
        return None

    def _read_poll_interval(self, status_obj: Any) -> float:
        for key in ("poll_interval", "pollInterval", "poll_interval_seconds"):
            value = self._get_attr_or_key(status_obj, key)
            if isinstance(value, (int, float)) and value > 0:
                if value > 100:
                    return min(value / 1000, 30)
                return min(float(value), 30)
        return settings.WEB_CONTENT_CRAWL_POLL_INTERVAL_SECONDS

    def _get_attr_or_key(self, value: Any, key: str) -> Any:
        if isinstance(value, dict):
            return value.get(key)
        return getattr(value, key, None)


web_content_service = WebContentService()
