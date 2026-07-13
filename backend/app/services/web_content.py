# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""External web content crawling and normalization."""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from html import escape
from typing import Any
from urllib.parse import urlparse

import httpx
from fastapi import HTTPException, status
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
from app.services.spider_job_client import SpiderJobError, spider_job_client

logger = logging.getLogger(__name__)

_XIAOHONGSHU_HOSTS = {"xiaohongshu.com", "xhslink.com"}
_DOUYIN_HOSTS = {"douyin.com"}
_BILIBILI_HOSTS = {"bilibili.com", "b23.tv"}
_COMMENT_JOB_SITES = {"douyin", "bilibili"}
_COMMENT_TIMEOUT_SECONDS = 60.0


@dataclass(frozen=True)
class _SpiderCrawlResult:
    article: dict[str, Any]
    comments: list[Any]
    page_rows: list[dict[str, Any]]
    comment_rows: list[dict[str, Any]]
    comment_fetch_status: str
    comment_fetch_error: str | None = None


@dataclass(frozen=True)
class ExternalWebContentPreview:
    """Normalized context data built from a spider job result."""

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
    """Fetch and normalize external web content through the spider job API."""

    async def crawl(self, url: str) -> ExternalWebContentPreview:
        source_url = self._validate_source_url(url)
        logger.info("[WEB_CONTENT_SPIDER] crawl_start url=%s", source_url)
        try:
            crawl_result = await self._crawl_with_spider(source_url)
        except SpiderJobError as exc:
            logger.warning("[WEB_CONTENT_SPIDER] page crawl failed error=%s", exc)
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="No supported media found in external web content result",
            ) from exc
        return self._build_preview(source_url, crawl_result)

    async def _crawl_with_spider(self, source_url: str) -> _SpiderCrawlResult:
        requested_site = self._detect_site(source_url)
        page_params = {"type": "page", "url": source_url, "options": ""}
        if requested_site == "xiaohongshu":
            page_params["options"] = '{"comment":1}'

        page_rows = await spider_job_client.run_job(page_params)
        article, inline_comments, has_inline_comments = self._parse_page_rows(page_rows)
        if has_inline_comments:
            return _SpiderCrawlResult(
                article=article,
                comments=inline_comments,
                page_rows=page_rows,
                comment_rows=[],
                comment_fetch_status="ready",
            )

        site = self._first_string(article, "site") or requested_site
        if site not in _COMMENT_JOB_SITES:
            return _SpiderCrawlResult(
                article=article,
                comments=[],
                page_rows=page_rows,
                comment_rows=[],
                comment_fetch_status="skipped",
            )

        comment_params = self._build_comment_job_params(
            site=site,
            source_url=source_url,
            article=article,
        )
        if comment_params is None:
            return _SpiderCrawlResult(
                article=article,
                comments=[],
                page_rows=page_rows,
                comment_rows=[],
                comment_fetch_status="skipped",
                comment_fetch_error="Bilibili article_id is missing",
            )

        try:
            async with asyncio.timeout(_COMMENT_TIMEOUT_SECONDS):
                comment_rows = await spider_job_client.run_job(comment_params)
                comments = self._extract_first_row_comments(comment_rows)
        except (SpiderJobError, TimeoutError) as exc:
            error = (
                str(exc)
                if isinstance(exc, SpiderJobError)
                else "External web comment crawl timed out"
            )
            logger.warning(
                "[WEB_CONTENT_SPIDER] comment crawl failed site=%s error=%s",
                site,
                error,
            )
            return _SpiderCrawlResult(
                article=article,
                comments=[],
                page_rows=page_rows,
                comment_rows=[],
                comment_fetch_status="failed",
                comment_fetch_error=error,
            )

        return _SpiderCrawlResult(
            article=article,
            comments=comments,
            page_rows=page_rows,
            comment_rows=comment_rows,
            comment_fetch_status="ready",
        )

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
            # End the read transaction before long-running external media I/O.
            db.rollback()
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
            "comment_fetch": preview.type_data.get("comment_fetch"),
            "image_urls": preview.type_data.get("images") or [],
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

    def _parse_page_rows(
        self,
        rows: list[dict[str, Any]],
    ) -> tuple[dict[str, Any], list[Any], bool]:
        if not rows:
            raise SpiderJobError("External web crawl result rows are empty")
        row = rows[0]
        nested_article = row.get("article")
        if isinstance(nested_article, dict):
            return nested_article, self._extract_first_row_comments(rows), True
        if not isinstance(row.get("site"), str) and not row.get("article_id"):
            raise SpiderJobError("External web content article is missing")
        return row, [], False

    def _extract_first_row_comments(
        self,
        rows: list[dict[str, Any]],
    ) -> list[Any]:
        if not rows:
            raise SpiderJobError("External web comment result rows are empty")
        raw_comments = rows[0].get("comments")
        if not isinstance(raw_comments, list):
            raise SpiderJobError("External web content comments are invalid")
        return raw_comments

    def _build_comment_job_params(
        self,
        *,
        site: str,
        source_url: str,
        article: dict[str, Any],
    ) -> dict[str, str] | None:
        if site == "douyin":
            return {"type": "comment", "url": source_url, "options": ""}
        article_id = article.get("article_id")
        if not isinstance(article_id, (str, int)) or not str(article_id).strip():
            return None
        return {
            "type": "comment",
            "site": "bilibili",
            "id": str(article_id).strip(),
            "options": "",
        }

    def _detect_site(self, source_url: str) -> str | None:
        hostname = (urlparse(source_url).hostname or "").lower()
        if self._matches_host(hostname, _XIAOHONGSHU_HOSTS):
            return "xiaohongshu"
        if self._matches_host(hostname, _DOUYIN_HOSTS):
            return "douyin"
        if self._matches_host(hostname, _BILIBILI_HOSTS):
            return "bilibili"
        return None

    def _matches_host(self, hostname: str, domains: set[str]) -> bool:
        return any(
            hostname == domain or hostname.endswith(f".{domain}") for domain in domains
        )

    def _build_preview(
        self,
        source_url: str,
        crawl_result: _SpiderCrawlResult,
    ) -> ExternalWebContentPreview:
        article = crawl_result.article
        videos = self._extract_videos(article)
        images = self._extract_images(article)
        comments = self._extract_comments(article, crawl_result.comments)
        page_content = self._extract_page_content(article)
        logger.info(
            "[WEB_CONTENT_SPIDER] normalize_result url=%s has_title=%s has_body=%s "
            "video_count=%s image_count=%s comment_count=%s",
            source_url,
            bool(page_content.get("title")),
            bool(page_content.get("body")),
            len(videos),
            len(images),
            len(comments),
        )
        if not page_content.get("body") and not videos and not images and not comments:
            logger.warning(
                "[WEB_CONTENT_SPIDER] no_supported_media url=%s",
                source_url,
            )
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="No supported media found in external web content result",
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
            "site": page_content.get("site"),
            "title": page_content.get("title"),
            "body": page_content.get("body"),
            "author_name": page_content.get("author_name"),
            "author_id": page_content.get("author_id"),
            "publish_time": page_content.get("publish_time"),
            "videos": videos,
            "images": images,
            "comments": comments,
            "comment_summary": self._build_comment_summary(article, comments),
            "comment_fetch": {
                "status": crawl_result.comment_fetch_status,
                "error": crawl_result.comment_fetch_error,
            },
            "raw_result": {
                "page": crawl_result.page_rows,
                "comments": crawl_result.comment_rows,
            },
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
                detail="No video_url found in external web content result",
            )

        filename = self._build_reference_filename(preview.name, index, total)
        try:
            content = await self._download_video(video_url.strip())
        except WebContentCrawlError:
            fallback_url = video.get("fallback_url")
            if not isinstance(fallback_url, str) or not fallback_url.strip():
                raise
            logger.warning(
                "[WEB_CONTENT_VIDEO] primary download failed; retrying fallback "
                "primary_host=%s fallback_host=%s",
                urlparse(video_url).netloc,
                urlparse(fallback_url).netloc,
            )
            content = await self._download_video(fallback_url.strip())
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
                "site": preview.site,
                "cover_url": video.get("cover_url"),
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

    def _extract_videos(self, article: dict[str, Any]) -> list[dict[str, Any]]:
        s3_url = self._first_string(article, "video_url_s3")
        original_url = self._first_string(article, "video_url")
        video_url = s3_url or original_url
        if not video_url:
            return []
        return [
            {
                "asset_id": "web-video-1",
                "role": "primary",
                "url": video_url,
                "fallback_url": (
                    original_url if s3_url and original_url != s3_url else None
                ),
                "cover_url": self._first_string(article, "cover_s3", "cover"),
                "mime_type": article.get("mime_type") or "video/mp4",
                "duration": article.get("duration"),
                "source_item_id": article.get("id") or article.get("article_id"),
            }
        ]

    def _extract_images(self, article: dict[str, Any]) -> list[dict[str, Any]]:
        images: list[dict[str, Any]] = []
        seen_urls: set[str] = set()
        original_urls = article.get("images")
        s3_urls = article.get("images_s3")
        if not isinstance(original_urls, list):
            original_urls = []
        if not isinstance(s3_urls, list):
            s3_urls = []
        for source_index in range(max(len(original_urls), len(s3_urls))):
            s3_url = self._normalize_absolute_http_url(
                s3_urls[source_index] if source_index < len(s3_urls) else None
            )
            original_url = self._normalize_absolute_http_url(
                original_urls[source_index]
                if source_index < len(original_urls)
                else None
            )
            selected_url = s3_url or original_url
            if not selected_url or selected_url in seen_urls:
                continue
            seen_urls.add(selected_url)
            image_index = len(images) + 1
            images.append(
                {
                    "asset_id": f"web-image-{image_index}",
                    "role": "primary" if image_index == 1 else "secondary",
                    "url": selected_url,
                    "source_item_id": article.get("id") or article.get("article_id"),
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
        normalized_url = normalized_url.replace("/format/heif", "/format/jpg")
        parsed = urlparse(normalized_url)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            return None
        return normalized_url

    def _extract_page_content(self, item: dict[str, Any] | None) -> dict[str, Any]:
        item = item or {}
        body = self._first_string(item, "content") or self._first_string(item, "desc")
        return {
            "primary_item_id": item.get("id") or item.get("article_id"),
            "article_id": item.get("article_id"),
            "site": self._first_string(item, "site"),
            "title": self._first_string(item, "title"),
            "body": body or "",
            "author_name": self._first_string(item, "user_name"),
            "author_id": self._identifier(item.get("user_id")),
            "publish_time": self._first_string(item, "pub_time"),
        }

    def _extract_comments(
        self,
        article: dict[str, Any],
        raw_comments: list[Any],
    ) -> list[dict[str, Any]]:
        comments: list[dict[str, Any]] = []
        seen_ids: set[str] = set()
        source_item_id = article.get("id") or article.get("article_id")
        for index, raw_comment in enumerate(raw_comments):
            if not isinstance(raw_comment, dict):
                continue
            content = self._first_string(raw_comment, "content")
            if not content:
                continue
            comment_id = self._identifier(raw_comment.get("comment_id"))
            raw_parent_id = raw_comment.get("parent_id")
            if raw_parent_id is None:
                raw_parent_id = raw_comment.get("target_id")
            raw_parent_id = self._identifier(raw_parent_id)
            parent_id = raw_parent_id if raw_parent_id not in {None, "0"} else None
            reply_count = raw_comment.get("reply_count")
            if reply_count is None:
                reply_count = raw_comment.get("sub_comment_count")
            dedupe_key = comment_id or f"{source_item_id}:{index}:{content}"
            if dedupe_key in seen_ids:
                continue
            seen_ids.add(dedupe_key)
            comments.append(
                {
                    "asset_id": f"web-comment-{len(comments) + 1}",
                    "comment_id": comment_id,
                    "parent_id": parent_id,
                    "author_name": self._first_string(raw_comment, "user_name"),
                    "author_id": self._identifier(raw_comment.get("user_id")),
                    "content": content,
                    "like_count": raw_comment.get("like_count"),
                    "reply_count": reply_count,
                    "created_at": self._first_string(raw_comment, "pub_time"),
                    "ip_location": self._first_string(raw_comment, "location"),
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

    def _first_string(self, mapping: dict[str, Any], *keys: str) -> str | None:
        for key in keys:
            value = mapping.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
        return None

    def _identifier(self, value: Any) -> str | None:
        if isinstance(value, (str, int)) and str(value).strip():
            return str(value).strip()
        return None

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


web_content_service = WebContentService()
