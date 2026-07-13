# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import asyncio
from dataclasses import dataclass

import pytest
from fastapi import HTTPException

from app.models.subtask_context import ContextStatus, ContextType, SubtaskContext
from app.models.user import User
from app.services.spider_job_client import SpiderJobError
from app.services.web_content import (
    WebContentCrawlError,
    WebContentService,
    _SpiderCrawlResult,
)


def _crawl_result(
    article: dict,
    comments: list[dict] | None = None,
    *,
    comment_fetch_status: str = "ready",
) -> _SpiderCrawlResult:
    page_rows = [{"article": article, "comments": comments or []}]
    return _SpiderCrawlResult(
        article=article,
        comments=comments or [],
        page_rows=page_rows,
        comment_rows=[],
        comment_fetch_status=comment_fetch_status,
    )


@pytest.mark.asyncio
async def test_crawl_uses_inline_comments_for_nested_xiaohongshu(monkeypatch):
    service = WebContentService()
    calls: list[dict[str, str]] = []
    comments = [
        {
            "comment_id": "comment-1",
            "content": "Great",
            "target_id": "",
            "sub_comment_count": 3,
            "sub_comments": [
                {
                    "comment_id": "reply-1",
                    "content": "Nested reply",
                    "target_id": "comment-1",
                    "sub_comment_count": 0,
                }
            ],
        }
    ]

    async def fake_run_job(params):
        calls.append(params)
        return [
            {
                "article": {
                    "id": "item-1",
                    "site": "xiaohongshu",
                    "content": "Page body",
                },
                "comments": comments,
            }
        ]

    monkeypatch.setattr(
        "app.services.web_content.spider_job_client.run_job", fake_run_job
    )

    preview = await service.crawl("https://www.xiaohongshu.com/explore/item-1")

    assert calls == [
        {
            "type": "page",
            "url": "https://www.xiaohongshu.com/explore/item-1",
            "options": '{"comment":1}',
        }
    ]
    assert preview.comment_count == 1
    assert preview.type_data["comments"][0]["parent_id"] is None
    assert preview.type_data["comments"][0]["reply_count"] == 3
    assert "Nested reply" not in str(preview.type_data["comments"])
    assert preview.type_data["comment_fetch"] == {"status": "ready", "error": None}


@pytest.mark.asyncio
async def test_crawl_fetches_douyin_comments_separately(monkeypatch):
    service = WebContentService()
    calls: list[dict[str, str]] = []

    async def fake_run_job(params):
        calls.append(params)
        if params["type"] == "page":
            return [
                {
                    "id": "item-1",
                    "article_id": "item-1",
                    "site": "douyin",
                    "content": "Page body",
                    "comment_count": 501,
                }
            ]
        return [
            {
                "comments": [
                    {
                        "comment_id": "comment-1",
                        "article_id": "item-1",
                        "content": "Great",
                        "parent_id": "0",
                    }
                ]
            }
        ]

    monkeypatch.setattr(
        "app.services.web_content.spider_job_client.run_job", fake_run_job
    )
    source_url = "https://www.douyin.com/note/item-1"

    preview = await service.crawl(source_url)

    assert calls == [
        {"type": "page", "url": source_url, "options": ""},
        {"type": "comment", "url": source_url, "options": ""},
    ]
    assert preview.type_data["comment_summary"] == {
        "total_count": 501,
        "fetched_count": 1,
    }
    assert preview.type_data["comments"][0]["parent_id"] is None
    assert (
        preview.type_data["raw_result"]["comments"][0]["comments"][0]["comment_id"]
        == "comment-1"
    )


@pytest.mark.asyncio
async def test_crawl_fetches_bilibili_comments_by_article_id(monkeypatch):
    service = WebContentService()
    calls: list[dict[str, str]] = []

    async def fake_run_job(params):
        calls.append(params)
        if params["type"] == "page":
            return [
                {
                    "id": "116894984116815",
                    "article_id": "116894984116815",
                    "site": "bilibili",
                    "content": "Page body",
                }
            ]
        return [
            {
                "comments": [
                    {
                        "comment_id": 308892461632,
                        "content": "Great",
                        "parent_id": "0",
                        "reply_count": 53,
                    }
                ]
            }
        ]

    monkeypatch.setattr(
        "app.services.web_content.spider_job_client.run_job", fake_run_job
    )
    source_url = "https://www.bilibili.com/video/BV1b8N765E5s"

    preview = await service.crawl(source_url)

    assert calls == [
        {"type": "page", "url": source_url, "options": ""},
        {
            "type": "comment",
            "site": "bilibili",
            "id": "116894984116815",
            "options": "",
        },
    ]
    assert preview.comment_count == 1
    assert preview.type_data["comments"][0]["comment_id"] == "308892461632"
    assert preview.type_data["comments"][0]["parent_id"] is None
    assert preview.type_data["comments"][0]["reply_count"] == 53


@pytest.mark.asyncio
async def test_flat_xiaohongshu_result_does_not_start_comment_job(monkeypatch):
    service = WebContentService()
    calls: list[dict[str, str]] = []

    async def fake_run_job(params):
        calls.append(params)
        return [{"site": "xiaohongshu", "content": "Page body"}]

    monkeypatch.setattr(
        "app.services.web_content.spider_job_client.run_job", fake_run_job
    )

    preview = await service.crawl("https://www.xiaohongshu.com/explore/item-1")

    assert len(calls) == 1
    assert preview.type_data["comment_fetch"]["status"] == "skipped"


@pytest.mark.asyncio
async def test_bilibili_missing_article_id_skips_comment_job(monkeypatch):
    service = WebContentService()
    calls: list[dict[str, str]] = []

    async def fake_run_job(params):
        calls.append(params)
        return [{"site": "bilibili", "content": "Page body"}]

    monkeypatch.setattr(
        "app.services.web_content.spider_job_client.run_job", fake_run_job
    )

    preview = await service.crawl("https://www.bilibili.com/video/BV1example")

    assert len(calls) == 1
    assert preview.type_data["comment_fetch"] == {
        "status": "skipped",
        "error": "Bilibili article_id is missing",
    }


@pytest.mark.asyncio
async def test_comment_failure_does_not_discard_page(monkeypatch):
    service = WebContentService()
    call_count = 0

    async def fake_run_job(_params):
        nonlocal call_count
        call_count += 1
        if call_count == 1:
            return [{"site": "douyin", "content": "Page body"}]
        raise SpiderJobError("comment service failed")

    monkeypatch.setattr(
        "app.services.web_content.spider_job_client.run_job", fake_run_job
    )

    preview = await service.crawl("https://www.douyin.com/video/item-1")

    assert preview.type_data["body"] == "Page body"
    assert preview.type_data["comments"] == []
    assert preview.type_data["comment_fetch"] == {
        "status": "failed",
        "error": "comment service failed",
    }


@pytest.mark.asyncio
async def test_comment_timeout_does_not_discard_page(monkeypatch):
    service = WebContentService()
    call_count = 0

    async def fake_run_job(_params):
        nonlocal call_count
        call_count += 1
        if call_count == 1:
            return [{"site": "douyin", "content": "Page body"}]
        await asyncio.Event().wait()

    monkeypatch.setattr(
        "app.services.web_content.spider_job_client.run_job", fake_run_job
    )
    monkeypatch.setattr("app.services.web_content._COMMENT_TIMEOUT_SECONDS", 0.01)

    preview = await service.crawl("https://www.douyin.com/video/item-1")

    assert preview.type_data["body"] == "Page body"
    assert preview.type_data["comments"] == []
    assert preview.type_data["comment_fetch"] == {
        "status": "failed",
        "error": "External web comment crawl timed out",
    }


@pytest.mark.asyncio
async def test_page_spider_error_returns_no_supported_media(monkeypatch):
    async def fake_run_job(_params):
        raise SpiderJobError("Spider API request failed")

    monkeypatch.setattr(
        "app.services.web_content.spider_job_client.run_job", fake_run_job
    )

    with pytest.raises(HTTPException) as exc_info:
        await WebContentService().crawl("https://www.xiaohongshu.com/explore/item-1")

    assert exc_info.value.status_code == 422
    assert (
        exc_info.value.detail
        == "No supported media found in external web content result"
    )


def test_parse_page_rows_auto_detects_nested_and_flat_structures():
    service = WebContentService()
    article = {"site": "xiaohongshu", "content": "body"}
    comments = [{"comment_id": "comment-1"}]

    assert service._parse_page_rows([{"article": article, "comments": comments}]) == (
        article,
        comments,
        True,
    )
    assert service._parse_page_rows([article]) == (article, [], False)


def test_extract_first_row_comments_rejects_invalid_structures():
    service = WebContentService()

    with pytest.raises(SpiderJobError, match="comment result rows are empty"):
        service._extract_first_row_comments([])
    with pytest.raises(SpiderJobError, match="comments are invalid"):
        service._extract_first_row_comments([{}])


@pytest.mark.parametrize(
    ("rows", "message"),
    [
        ([], "result rows are empty"),
        ([{"comments": []}], "article is missing"),
        (
            [{"article": {"site": "xiaohongshu"}, "comments": {}}],
            "comments are invalid",
        ),
    ],
)
def test_parse_page_rows_rejects_invalid_structures(rows, message):
    with pytest.raises(SpiderJobError, match=message):
        WebContentService()._parse_page_rows(rows)


def test_build_preview_prefers_s3_media_and_falls_back_per_asset():
    service = WebContentService()
    article = {
        "id": "item-1",
        "site": "douyin",
        "video_url": "https://origin.example.com/video.mp4",
        "video_url_s3": "https://s3.example.com/video.mp4",
        "cover": "https://origin.example.com/cover.jpg",
        "cover_s3": "https://s3.example.com/cover.jpg",
        "images": [
            "https://origin.example.com/a.jpg",
            "https://origin.example.com/b.jpg",
        ],
        "images_s3": ["https://s3.example.com/a.jpg", ""],
    }

    preview = service._build_preview(
        "https://example.com/post/1", _crawl_result(article)
    )

    assert preview.type_data["videos"][0]["url"] == "https://s3.example.com/video.mp4"
    assert (
        preview.type_data["videos"][0]["fallback_url"]
        == "https://origin.example.com/video.mp4"
    )
    assert (
        preview.type_data["videos"][0]["cover_url"]
        == "https://s3.example.com/cover.jpg"
    )
    assert [image["url"] for image in preview.type_data["images"]] == [
        "https://s3.example.com/a.jpg",
        "https://origin.example.com/b.jpg",
    ]
    assert "image_urls" not in preview.type_data


def test_build_preview_falls_back_to_original_media_urls():
    article = {
        "id": "item-1",
        "video_url": "https://origin.example.com/video.mp4",
        "cover": "https://origin.example.com/cover.jpg",
        "images": ["https://origin.example.com/a.jpg"],
    }

    preview = WebContentService()._build_preview(
        "https://example.com/post/1", _crawl_result(article)
    )

    assert (
        preview.type_data["videos"][0]["url"] == "https://origin.example.com/video.mp4"
    )
    assert preview.type_data["videos"][0]["fallback_url"] is None
    assert preview.cover_url == "https://origin.example.com/cover.jpg"
    assert preview.type_data["images"][0]["url"] == "https://origin.example.com/a.jpg"


def test_build_preview_requests_jpg_for_heif_images():
    article = {
        "images": [
            "https://sns.example.com/image?imageView2/2/format/heif/q/45",
        ],
    }

    preview = WebContentService()._build_preview(
        "https://example.com/post/1", _crawl_result(article)
    )

    assert preview.type_data["images"][0]["url"] == (
        "https://sns.example.com/image?imageView2/2/format/jpg/q/45"
    )


def test_build_preview_normalizes_numeric_author_id():
    preview = WebContentService()._build_preview(
        "https://example.com/post/1",
        _crawl_result({"site": "bilibili", "content": "body", "user_id": 456664753}),
    )

    assert preview.type_data["author_id"] == "456664753"


def test_build_preview_extracts_top_level_comments_only():
    comments = [
        {
            "comment_id": "comment-1",
            "content": "Great post",
            "user_name": "Bob",
            "user_id": "user-2",
            "pub_time": "2026-07-11T11:00:00",
            "location": "Beijing",
            "like_count": 3,
            "sub_comment_count": 1,
            "target_id": "0",
            "sub_comments": [{"comment_id": "reply-1", "content": "Nested reply"}],
        }
    ]
    article = {"id": "item-1", "comment_count": 14}

    preview = WebContentService()._build_preview(
        "https://example.com/post/1", _crawl_result(article, comments)
    )

    assert preview.type_data["comment_summary"] == {
        "total_count": 14,
        "fetched_count": 1,
    }
    assert preview.type_data["comments"][0]["parent_id"] is None
    assert preview.type_data["comments"][0]["reply_count"] == 1
    assert "Nested reply" not in str(preview.type_data["comments"])


def test_build_preview_rejects_title_only_result():
    service = WebContentService()

    with pytest.raises(HTTPException) as exc_info:
        service._build_preview(
            "https://example.com/post/1",
            _crawl_result({"id": "item-1", "title": "Title only"}),
        )

    assert exc_info.value.status_code == 422
    assert (
        exc_info.value.detail
        == "No supported media found in external web content result"
    )


@dataclass
class _UploadResult:
    fid: int
    request_id: str = "req-1"
    url: str = ""


@pytest.mark.asyncio
async def test_create_context_persists_selected_video_url(monkeypatch, test_db):
    service = WebContentService()
    article = {
        "id": "item-1",
        "site": "xiaohongshu",
        "title": "Video post",
        "video_url": "https://media.example.com/original.mp4",
        "video_url_s3": "https://media.example.com/stored.mp4",
        "cover_s3": "https://media.example.com/a.jpg",
    }
    preview = service._build_preview(
        "https://example.com/post/1", _crawl_result(article)
    )

    async def fake_download(video_url: str) -> bytes:
        assert video_url == "https://media.example.com/stored.mp4"
        return b"video-bytes"

    async def fake_upload_video_bytes(**kwargs):
        assert kwargs["content"] == b"video-bytes"
        return _UploadResult(fid=12345)

    monkeypatch.setattr(service, "_download_video", fake_download)
    monkeypatch.setattr(
        "app.services.web_content.weibo_media_service.upload_video_bytes",
        fake_upload_video_bytes,
    )

    contexts = await service.create_context(test_db, user=User(id=7), preview=preview)

    aggregate = contexts[0]
    video_id = aggregate.type_data["asset_context_ids"]["videos"][0]
    video_context = test_db.get(SubtaskContext, video_id)
    assert aggregate.context_type == ContextType.EXTERNAL_WEB_CONTENT.value
    assert aggregate.type_data["cover_url"] == "https://media.example.com/a.jpg"
    assert aggregate.type_data["comment_fetch"]["status"] == "ready"
    assert video_context.type_data["fid"] == 12345


@pytest.mark.asyncio
async def test_create_context_falls_back_when_s3_video_download_fails(
    monkeypatch, test_db
):
    service = WebContentService()
    article = {
        "id": "item-1",
        "site": "douyin",
        "title": "Video post",
        "video_url_s3": "https://s3.example.com/expired.mp4",
        "video_url": "https://origin.example.com/video.mp4",
    }
    preview = service._build_preview(
        "https://www.douyin.com/video/item-1", _crawl_result(article)
    )
    downloaded_urls: list[str] = []

    async def fake_download(video_url: str) -> bytes:
        downloaded_urls.append(video_url)
        if "s3.example.com" in video_url:
            raise WebContentCrawlError("download failed with status 404")
        return b"fallback-video"

    async def fake_upload_video_bytes(**kwargs):
        assert kwargs["content"] == b"fallback-video"
        return _UploadResult(fid=12345)

    monkeypatch.setattr(service, "_download_video", fake_download)
    monkeypatch.setattr(
        "app.services.web_content.weibo_media_service.upload_video_bytes",
        fake_upload_video_bytes,
    )

    await service.create_context(test_db, user=User(id=7), preview=preview)

    assert downloaded_urls == [
        "https://s3.example.com/expired.mp4",
        "https://origin.example.com/video.mp4",
    ]


@pytest.mark.asyncio
async def test_create_context_stores_images_and_comments(monkeypatch, test_db):
    service = WebContentService()
    article = {
        "id": "item-1",
        "site": "xiaohongshu",
        "title": "Image post",
        "content": "Page body",
        "comment_count": 14,
        "images": ["https://public.example.com/a.jpg"],
    }
    comments = [{"comment_id": "comment-1", "user_name": "Alice", "content": "Great"}]
    preview = service._build_preview(
        "https://example.com/post/1", _crawl_result(article, comments)
    )

    async def fake_upload_url(url, *, uid):
        assert url == "https://public.example.com/a.jpg"
        return "image-pid-1"

    def fake_upload_attachment(**kwargs):
        context = SubtaskContext(
            subtask_id=0,
            user_id=kwargs["user_id"],
            context_type=ContextType.ATTACHMENT.value,
            name=kwargs["filename"],
            status=ContextStatus.READY.value,
            binary_data=b"",
            image_base64="",
            extracted_text=kwargs["binary_data"].decode(),
            text_length=len(kwargs["binary_data"]),
            error_message="",
            type_data={
                "original_filename": kwargs["filename"],
                "file_extension": ".md",
                "file_size": len(kwargs["binary_data"]),
                "mime_type": "text/markdown",
                **kwargs["extra_type_data"],
            },
        )
        kwargs["db"].add(context)
        kwargs["db"].flush()
        return context, None

    monkeypatch.setattr(
        "app.services.web_content.weibo_image_upload_service.upload_url",
        fake_upload_url,
    )
    monkeypatch.setattr(
        "app.services.web_content.context_service.upload_attachment",
        fake_upload_attachment,
    )

    contexts = await service.create_context(test_db, user=User(id=7), preview=preview)

    aggregate = contexts[0]
    assert aggregate.type_data["image_urls"][0]["pid"] == "image-pid-1"
    assert aggregate.type_data["comment_count"] == 14
    assert aggregate.type_data["fetched_comment_count"] == 1
    assert aggregate.type_data["asset_context_ids"]["comments"]
