# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""External web content crawling and normalization."""

from __future__ import annotations

import asyncio
import json
import logging
from dataclasses import dataclass
from html import escape
from typing import Any
from urllib.parse import urlparse

import httpx
from fastapi import HTTPException, status
from fastapi.encoders import jsonable_encoder
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.subtask_context import ContextStatus, ContextType, SubtaskContext
from app.models.user import User
from app.services.attachment.parser import DocumentParser
from app.services.context import context_service
from app.services.media.weibo_image_upload import (
    WeiboImageUploadError,
    weibo_image_upload_service,
)
from app.services.media.weibo_media_service import (
    resolve_weibo_media_uid,
    weibo_media_service,
)

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
    def image_count(self) -> int:
        return len(self.type_data.get("images") or [])

    @property
    def comment_count(self) -> int:
        return len(self.type_data.get("comments") or [])

    @property
    def site(self) -> str | None:
        return self.type_data.get("site")

    @property
    def cover_url(self) -> str | None:
        for asset in self.type_data.get("videos") or []:
            if isinstance(asset, dict) and asset.get("cover_url"):
                return asset["cover_url"]
        for asset in self.type_data.get("images") or []:
            if isinstance(asset, dict) and asset.get("url"):
                return asset["url"]
        return None


class WebContentCrawlError(Exception):
    """Raised when external web content crawling fails."""


class WebContentService:
    """Fetch and normalize external web content through spider MCP."""

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
        """Persist crawled external web content as one aggregate context."""
        asset_contexts: list[SubtaskContext] = []
        try:
            videos = preview.type_data.get("videos") or []
            images = preview.type_data.get("images") or []
            comments = preview.type_data.get("comments") or []

            uid = resolve_weibo_media_uid(user)
            db.commit()
            for image in images:
                if not isinstance(image, dict) or not image.get("url"):
                    continue
                try:
                    image["pid"] = await weibo_image_upload_service.upload_url(
                        image["url"], uid=uid
                    )
                    image["pid_status"] = "ready"
                except WeiboImageUploadError as exc:
                    image["pid_status"] = "failed"
                    image["pid_error"] = exc.code
                    logger.warning(
                        "[WEB_CONTENT_IMAGE] PID generation skipped url=%s error=%s",
                        image["url"],
                        exc,
                    )
                except Exception as exc:
                    image["pid_status"] = "failed"
                    image["pid_error"] = "upload_failed"
                    logger.warning(
                        "[WEB_CONTENT_IMAGE] PID generation failed url=%s error=%s",
                        image["url"],
                        exc,
                    )

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
                asset_contexts.append(context)

            if comments:
                context = self._create_comments_attachment(
                    db=db,
                    user=user,
                    preview=preview,
                    comments=comments,
                )
                asset_contexts.append(context)

            db.flush()
            aggregate_context = self._create_aggregate_context(
                user=user,
                preview=preview,
                asset_contexts=asset_contexts,
            )
            db.add(aggregate_context)
            db.commit()
            db.refresh(aggregate_context)
            return [aggregate_context]
        except Exception:
            db.rollback()
            raise

    def _create_aggregate_context(
        self,
        *,
        user: User,
        preview: ExternalWebContentPreview,
        asset_contexts: list[SubtaskContext],
    ) -> SubtaskContext:
        asset_ids = self._group_asset_context_ids(asset_contexts)
        summary = preview.type_data.get("comment_summary") or {}
        type_data = {
            "source": "external_web_content",
            "external_media_type": "mixed",
            "external_source_url": preview.source_url,
            "site": preview.site,
            "title": preview.type_data.get("title"),
            "body": preview.type_data.get("body"),
            "author_name": preview.type_data.get("author_name"),
            "author_id": preview.type_data.get("author_id"),
            "publish_time": preview.type_data.get("publish_time"),
            "cover_url": preview.cover_url,
            "video_count": preview.video_count,
            "image_count": preview.image_count,
            "comment_count": summary.get("total_count"),
            "fetched_comment_count": summary.get("fetched_count"),
            "image_urls": preview.type_data.get("image_urls") or [],
            "asset_context_ids": asset_ids,
            "raw_result": preview.type_data.get("raw_result"),
        }
        return SubtaskContext(
            subtask_id=0,
            user_id=user.id,
            context_type=ContextType.EXTERNAL_WEB_CONTENT.value,
            name=preview.name,
            status=ContextStatus.READY.value,
            binary_data=b"",
            extracted_text="",
            text_length=0,
            image_base64="",
            error_message="",
            type_data=type_data,
        )

    def _group_asset_context_ids(
        self,
        asset_contexts: list[SubtaskContext],
    ) -> dict[str, list[int]]:
        grouped: dict[str, list[int]] = {
            "videos": [],
            "comments": [],
        }
        for context in asset_contexts:
            if not context.id or not isinstance(context.type_data, dict):
                continue
            media_type = context.type_data.get("external_media_type")
            if media_type == "video":
                grouped["videos"].append(context.id)
            elif media_type == "comments":
                grouped["comments"].append(context.id)
        return grouped

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
        images = self._extract_images(items)
        comments = self._extract_comments(items)
        primary_item = items[0] if items else None
        page_content = self._extract_page_content(primary_item)
        logger.info(
            "[WEB_CONTENT_MCP] normalize_result url=%s raw_type=%s item_count=%s "
            "item_keys=%s has_title=%s has_body=%s video_count=%s image_count=%s comment_count=%s",
            source_url,
            type(raw_data).__name__,
            len(items),
            [sorted(item.keys()) for item in items[:5]],
            bool(page_content.get("title")),
            bool(page_content.get("body")),
            len(videos),
            len(images),
            len(comments),
        )
        if not page_content.get("body") and not videos and not images and not comments:
            logger.warning(
                "[WEB_CONTENT_MCP] no_supported_media url=%s raw_data=%s",
                source_url,
                self._serialize_for_log(raw_data),
            )
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="No supported media found in external web content result",
            )

        max_videos = settings.WEB_CONTENT_MAX_VIDEOS_PER_CONTEXT
        if len(videos) > max_videos:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=f"External web content contains more than {max_videos} videos",
            )

        max_images = settings.WEB_CONTENT_MAX_IMAGES_PER_CONTEXT
        if len(images) > max_images:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=f"External web content contains more than {max_images} images",
            )

        name = self._build_context_name(page_content, source_url)

        type_data = {
            "source": "external_web_content",
            "source_url": source_url,
            "crawl_tool": crawl_tool or settings.WEB_CONTENT_CRAWL_TOOL,
            "site": page_content.get("site"),
            "title": page_content.get("title"),
            "body": page_content.get("body"),
            "author_name": page_content.get("author_name"),
            "author_id": page_content.get("author_id"),
            "publish_time": page_content.get("publish_time"),
            "videos": videos,
            "images": images,
            "image_urls": images,
            "comments": comments,
            "comment_summary": self._build_comment_summary(primary_item, comments),
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
                "external_media_type": "video",
                "external_source_url": preview.source_url,
                "external_video_index": index - 1,
            },
        )

    def _create_comments_attachment(
        self,
        *,
        db: Session,
        user: User,
        preview: ExternalWebContentPreview,
        comments: list[dict[str, Any]],
    ) -> SubtaskContext:
        filename = self._build_reference_filename(
            f"{preview.name} comments",
            extension=".md",
            fallback_name="external-web-comments",
        )
        content = self._format_comments_markdown(preview, comments).encode("utf-8")
        summary = preview.type_data.get("comment_summary") or {}
        context, _truncation = context_service.upload_attachment(
            db=db,
            user_id=user.id,
            filename=filename,
            binary_data=content,
            subtask_id=0,
            extra_type_data={
                "source": "external_web_content",
                "external_media_type": "comments",
                "external_source_url": preview.source_url,
                "site": preview.site,
                "comment_count": summary.get("total_count"),
                "fetched_comment_count": summary.get("fetched_count"),
            },
            commit=False,
        )
        logger.info(
            "[WEB_CONTENT_COMMENTS] persisted source_url=%s filename=%s count=%s",
            preview.source_url,
            filename,
            len(comments),
        )
        return context

    async def _download_video(self, video_url: str) -> bytes:
        self._validate_media_url(video_url)
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
        self,
        name: str,
        index: int = 1,
        total: int = 1,
        *,
        extension: str = ".mp4",
        fallback_name: str = "external-web-video",
    ) -> str:
        safe_name = "".join(
            ch if ch.isalnum() or ch in {" ", "-", "_"} else "_" for ch in name
        ).strip()
        if not safe_name:
            safe_name = fallback_name
        suffix = f"-{index}" if total > 1 else ""
        return f"{safe_name[:120]}{suffix}{extension}"

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

    def _extract_images(self, items: list[dict[str, Any]]) -> list[dict[str, Any]]:
        images: list[dict[str, Any]] = []
        seen_urls: set[str] = set()
        for item in items:
            public_urls = self._as_string_list(item.get("images"))
            for source_index, public_value in enumerate(public_urls):
                public_url = self._normalize_absolute_http_url(public_value)
                if not public_url:
                    continue
                if public_url in seen_urls:
                    continue
                seen_urls.add(public_url)
                image_index = len(images) + 1
                images.append(
                    {
                        "asset_id": f"web-image-{image_index}",
                        "role": "primary" if image_index == 1 else "secondary",
                        "url": public_url,
                        "source_item_id": item.get("id") or item.get("article_id"),
                        "source_index": source_index,
                    }
                )
        return images

    def _normalize_absolute_http_url(self, url: Any) -> str | None:
        if not isinstance(url, str):
            return None
        normalized_url = url.strip()
        if not normalized_url:
            return None
        parsed = urlparse(normalized_url)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            return None
        return normalized_url

    def _extract_page_content(self, item: dict[str, Any] | None) -> dict[str, Any]:
        item = item or {}
        desc = self._first_string(item, "desc")
        text = self._first_string(item, "text")
        body_parts = []
        for value in (desc, text):
            if value and value not in body_parts:
                body_parts.append(value)
        return {
            "primary_item_id": item.get("id") or item.get("article_id"),
            "article_id": item.get("article_id"),
            "site": self._first_string(item, "site"),
            "title": self._first_string(item, "title"),
            "body": "\n\n".join(body_parts),
            "author_name": self._first_string(
                item,
                "user_name",
                "author_name",
                "nickname",
            ),
            "author_id": self._first_string(item, "user_id", "author_id"),
            "publish_time": self._first_string(
                item,
                "pub_time",
                "publish_time",
                "created_at",
            ),
        }

    def _extract_comments(self, items: list[dict[str, Any]]) -> list[dict[str, Any]]:
        comments: list[dict[str, Any]] = []
        seen_ids: set[str] = set()
        for item in items:
            raw_comments = item.get("comments")
            if not isinstance(raw_comments, list):
                continue
            source_item_id = item.get("id") or item.get("article_id")
            for index, raw_comment in enumerate(raw_comments):
                if not isinstance(raw_comment, dict):
                    continue
                content = self._first_string(
                    raw_comment,
                    "content",
                    "text",
                    "comment",
                    "comment_content",
                )
                if not content:
                    continue
                comment_id = self._first_string(raw_comment, "id", "comment_id")
                dedupe_key = comment_id or f"{source_item_id}:{index}:{content}"
                if dedupe_key in seen_ids:
                    continue
                seen_ids.add(dedupe_key)
                comments.append(
                    {
                        "asset_id": f"web-comment-{len(comments) + 1}",
                        "comment_id": comment_id,
                        "parent_id": self._first_string(
                            raw_comment, "parent_id", "parent_comment_id"
                        ),
                        "author_name": self._first_string(
                            raw_comment, "user_name", "author_name", "nickname"
                        ),
                        "author_id": self._first_string(
                            raw_comment, "user_id", "author_id"
                        ),
                        "content": content,
                        "like_count": raw_comment.get("like_count")
                        or raw_comment.get("liked_count"),
                        "reply_count": raw_comment.get("reply_count"),
                        "created_at": self._first_string(
                            raw_comment, "created_at", "pub_time", "publish_time"
                        ),
                        "ip_location": self._first_string(
                            raw_comment, "ip_location", "location"
                        ),
                        "source_item_id": source_item_id,
                    }
                )
        return comments

    def _build_comment_summary(
        self,
        primary_item: dict[str, Any] | None,
        comments: list[dict[str, Any]],
    ) -> dict[str, Any]:
        item = primary_item or {}
        total_count = item.get("comment_count")
        if not isinstance(total_count, int):
            total_count = len(comments)
        return {
            "total_count": total_count,
            "fetched_count": len(comments),
        }

    def _format_comments_markdown(
        self,
        preview: ExternalWebContentPreview,
        comments: list[dict[str, Any]],
    ) -> str:
        summary = preview.type_data.get("comment_summary") or {}
        lines = [
            "# External Web First-Screen Comments",
            "",
            f"- Source: {preview.source_url}",
            f"- Site: {preview.type_data.get('site') or ''}",
            f"- Title: {preview.type_data.get('title') or preview.name}",
            f"- Platform comment count: {summary.get('total_count', len(comments))}",
            f"- Fetched comment count: {summary.get('fetched_count', len(comments))}",
            "",
            "## Comments",
            "",
        ]
        for index, comment in enumerate(comments, start=1):
            author = comment.get("author_name") or "Unknown"
            metadata = [f"@{author}"]
            if comment.get("created_at"):
                metadata.append(str(comment["created_at"]))
            if comment.get("like_count") is not None:
                metadata.append(f"{comment['like_count']} likes")
            if comment.get("parent_id"):
                metadata.append(f"reply_to={comment['parent_id']}")
            lines.extend(
                [
                    f"{index}. {' · '.join(metadata)}",
                    f"   {escape(str(comment.get('content') or ''))}",
                    "",
                ]
            )
        return "\n".join(lines).strip() + "\n"

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

    def _validate_media_url(self, url: str) -> None:
        parsed = urlparse(url)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="External web media URL must be an absolute HTTP(S) URL",
            )

        allowed_hosts = settings.WEB_CONTENT_ALLOWED_MEDIA_HOSTS
        if allowed_hosts and parsed.hostname not in allowed_hosts:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="External web media host is not allowed",
            )

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

    def _as_string_list(self, value: Any) -> list[str]:
        if not isinstance(value, list):
            return []
        strings: list[str] = []
        for item in value:
            if isinstance(item, str) and item.strip():
                strings.append(item.strip())
        return strings

    def _first_string(self, mapping: dict[str, Any], *keys: str) -> str | None:
        for key in keys:
            value = mapping.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
        return None

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

    def _build_context_name(self, page_content: dict[str, Any], source_url: str) -> str:
        title = page_content.get("title")
        if isinstance(title, str) and title.strip():
            return title.strip()

        body = page_content.get("body")
        if isinstance(body, str) and body.strip():
            return body.strip()[:10]

        return self._build_fallback_name(source_url)

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
