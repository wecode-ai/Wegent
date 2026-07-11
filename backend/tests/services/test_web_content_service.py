# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from dataclasses import dataclass

import pytest
from fastapi import HTTPException

from app.models.subtask_context import ContextStatus, ContextType, SubtaskContext
from app.models.user import User
from app.services.web_content import WebContentService


def test_build_preview_extracts_all_videos_and_keeps_raw_data():
    service = WebContentService()
    raw_data = [
        {
            "id": "item-1",
            "site": "weibo",
            "title": "Video post",
            "text": "Post content",
            "user_name": "Alice",
            "video_url": "https://origin.example.com/a.mp4",
            "video_url_s3": "https://s3.example.com/a.mp4",
            "cover": "https://origin.example.com/a.jpg",
            "cover_s3": "https://s3.example.com/a.jpg",
        },
        {
            "id": "item-2",
            "site": "weibo",
            "title": "Video post",
            "video_url": "https://origin.example.com/b.mp4",
            "video_url_s3": "https://s3.example.com/b.mp4",
        },
    ]

    preview = service._build_preview("https://weibo.com/post/1", raw_data)

    assert preview.name == "Video post"
    assert preview.video_count == 2
    assert preview.type_data["raw_result"] == raw_data
    assert [asset["url"] for asset in preview.type_data["videos"]] == [
        "https://s3.example.com/a.mp4",
        "https://s3.example.com/b.mp4",
    ]
    assert preview.type_data["author_name"] == "Alice"
    assert preview.type_data["title"] == "Video post"
    assert preview.type_data["body"] == "Post content"


def test_build_preview_deduplicates_videos():
    service = WebContentService()
    raw_data = [
        {"id": "item-1", "video_url_s3": "https://s3.example.com/a.mp4"},
        {"id": "item-2", "video_url_s3": "https://s3.example.com/a.mp4"},
    ]

    preview = service._build_preview("https://example.com/post/1", raw_data)

    assert preview.video_count == 1
    assert preview.type_data["videos"][0]["source_item_id"] == "item-1"


def test_build_preview_extracts_images_without_video():
    service = WebContentService()
    raw_data = [
        {
            "id": "item-1",
            "site": "xiaohongshu",
            "title": "Image post",
            "images": [
                "https://public.example.com/a.jpg",
                "https://public.example.com/b.jpg",
            ],
            "images_s3": [
                "https://s3.example.com/a.jpg",
                "https://s3.example.com/b.jpg",
            ],
            # Empty video URLs from spider results should not create video assets.
            "video_url_s3": "",
        }
    ]

    preview = service._build_preview("https://example.com/post/1", raw_data)

    assert preview.video_count == 0
    assert preview.image_count == 2
    assert [asset["url"] for asset in preview.type_data["images"]] == [
        "https://public.example.com/a.jpg",
        "https://public.example.com/b.jpg",
    ]
    assert [asset["url"] for asset in preview.type_data["image_urls"]] == [
        "https://public.example.com/a.jpg",
        "https://public.example.com/b.jpg",
    ]
    assert "download_url" not in preview.type_data["images"][0]
    assert "internal_url" not in preview.type_data["images"][0]
    assert "public_url" not in preview.type_data["images"][0]


def test_build_preview_ignores_non_http_image_urls():
    service = WebContentService()
    raw_data = [
        {
            "id": "item-1",
            "desc": "Page body keeps the preview valid",
            "images": ["javascript:alert(1)", "file:///tmp/a.jpg"],
            "images_s3": ["https://s3.example.com/a.jpg"],
        }
    ]

    preview = service._build_preview("https://example.com/post/1", raw_data)

    assert preview.image_count == 0
    assert preview.type_data["images"] == []
    assert preview.type_data["image_urls"] == []


def test_build_preview_ignores_internal_image_urls():
    service = WebContentService()
    raw_data = [
        {
            "id": "item-1",
            "desc": "Page body keeps the preview valid",
            "images_s3": [
                "https://s3.example.com/a.jpg",
                "https://s3.example.com/b.jpg",
            ],
        }
    ]

    preview = service._build_preview("https://example.com/post/1", raw_data)

    assert preview.image_count == 0
    assert preview.type_data["images"] == []
    assert preview.type_data["image_urls"] == []
    assert "https://s3.example.com/a.jpg" in str(preview.type_data["raw_result"])


def test_build_preview_deduplicates_public_image_urls():
    service = WebContentService()
    raw_data = [
        {
            "id": "item-1",
            "images": [
                "https://public.example.com/a.jpg",
                "https://public.example.com/a.jpg",
            ],
        }
    ]

    preview = service._build_preview("https://example.com/post/1", raw_data)

    assert preview.image_count == 1
    assert [asset["url"] for asset in preview.type_data["image_urls"]] == [
        "https://public.example.com/a.jpg",
    ]


def test_build_preview_extracts_images_without_video_legacy_internal_ignored():
    service = WebContentService()
    raw_data = [
        {
            "id": "item-1",
            "site": "xiaohongshu",
            "title": "Image post",
            "images": [
                "https://public.example.com/a.jpg",
                "https://public.example.com/b.jpg",
            ],
            "images_s3": [
                "https://s3.example.com/a.jpg",
                "https://s3.example.com/b.jpg",
            ],
        }
    ]

    preview = service._build_preview("https://example.com/post/1", raw_data)

    assert preview.image_count == 2
    assert [asset["url"] for asset in preview.type_data["images"]] == [
        "https://public.example.com/a.jpg",
        "https://public.example.com/b.jpg",
    ]


def test_build_preview_extracts_first_screen_comments():
    service = WebContentService()
    raw_data = [
        {
            "id": "item-1",
            "site": "xiaohongshu",
            "title": "Comment post",
            "comment_count": 14,
            "comments": [
                {
                    "id": "comment-1",
                    "user_name": "Alice",
                    "content": "Great post",
                    "like_count": 3,
                },
                {
                    "id": "comment-2",
                    "user_name": "Bob",
                    "content": "Useful",
                },
            ],
        }
    ]

    preview = service._build_preview("https://example.com/post/1", raw_data)

    assert preview.comment_count == 2
    assert preview.type_data["comment_summary"] == {
        "total_count": 14,
        "fetched_count": 2,
    }
    assert preview.type_data["comments"][0]["author_name"] == "Alice"
    assert preview.type_data["comments"][0]["content"] == "Great post"


def test_build_preview_uses_body_prefix_when_title_is_missing():
    service = WebContentService()
    raw_data = [
        {
            "id": "item-1",
            "title": None,
            "desc": "一二三四五六七八九十十一",
        }
    ]

    preview = service._build_preview("https://example.com/post/1", raw_data)

    assert preview.name == "一二三四五六七八九十"
    assert preview.type_data["title"] is None
    assert preview.type_data["body"] == "一二三四五六七八九十十一"


def test_serialize_for_log_expands_plain_objects():
    class DummyResult:
        def __init__(self):
            self.content = [{"type": "text", "text": "[]"}]
            self.structured_content = {"result": "[]"}
            self.data = "[]"
            self.is_error = False

    service = WebContentService()

    logged = service._serialize_for_log(DummyResult())

    assert '"content": [{"type": "text", "text": "[]"}]' in logged
    assert '"structured_content": {"result": "[]"}' in logged
    assert '"is_error": false' in logged
    assert "DummyResult" not in logged


@dataclass
class _UploadResult:
    fid: int
    request_id: str = "req-1"
    url: str = ""


@pytest.mark.asyncio
async def test_create_context_persists_crawled_external_web_video_as_weibo_attachment(
    monkeypatch,
    test_db,
):
    service = WebContentService()
    preview = service._build_preview(
        "https://example.com/post/1",
        [
            {
                "id": "item-1",
                "title": "Video post",
                "video_url_s3": "https://s3.example.com/a.mp4",
            }
        ],
    )

    async def fake_download(video_url: str) -> bytes:
        assert video_url == "https://s3.example.com/a.mp4"
        return b"video-bytes"

    async def fake_upload_video_bytes(**kwargs):
        assert kwargs["filename"] == "Video post.mp4"
        assert kwargs["content"] == b"video-bytes"
        return _UploadResult(fid=12345)

    monkeypatch.setattr(service, "_download_video", fake_download)
    monkeypatch.setattr(
        "app.services.web_content.weibo_media_service.upload_video_bytes",
        fake_upload_video_bytes,
    )

    user = User(id=7)
    contexts = await service.create_context(test_db, user=user, preview=preview)

    assert len(contexts) == 1
    context = contexts[0]
    assert context.id
    assert context.subtask_id == 0
    assert context.user_id == 7
    assert context.context_type == ContextType.EXTERNAL_WEB_CONTENT.value
    assert context.name == "Video post"
    assert context.type_data["source"] == "external_web_content"
    assert context.type_data["external_media_type"] == "mixed"
    assert context.type_data["video_count"] == 1
    assert context.type_data["image_count"] == 0
    assert context.type_data["asset_context_ids"]["videos"]
    assert context.type_data["external_source_url"] == "https://example.com/post/1"
    assert (
        context.type_data["raw_result"][0]["video_url_s3"]
        == "https://s3.example.com/a.mp4"
    )
    video_context = test_db.get(
        SubtaskContext,
        context.type_data["asset_context_ids"]["videos"][0],
    )
    assert video_context.name == "Video post.mp4"
    assert video_context.type_data["external_video_index"] == 0
    assert "raw_result" not in video_context.type_data
    assert video_context.type_data["storage_backend"] == "weibo"
    assert video_context.type_data["fid"] == 12345


@pytest.mark.asyncio
async def test_create_context_creates_one_weibo_attachment_per_video(
    monkeypatch,
    test_db,
):
    service = WebContentService()
    preview = service._build_preview(
        "https://example.com/post/1",
        [
            {"id": "item-1", "title": "Video post", "video_url_s3": "https://s3/a.mp4"},
            {"id": "item-2", "title": "Video post", "video_url_s3": "https://s3/b.mp4"},
        ],
    )
    downloaded: list[str] = []

    async def fake_download(video_url: str) -> bytes:
        downloaded.append(video_url)
        return f"bytes-{len(downloaded)}".encode()

    async def fake_upload_video_bytes(**_kwargs):
        return _UploadResult(fid=10000 + len(downloaded), request_id="req")

    monkeypatch.setattr(service, "_download_video", fake_download)
    monkeypatch.setattr(
        "app.services.web_content.weibo_media_service.upload_video_bytes",
        fake_upload_video_bytes,
    )

    user = User(id=7)
    contexts = await service.create_context(test_db, user=user, preview=preview)

    assert len(contexts) == 1
    aggregate_context = contexts[0]
    asset_ids = aggregate_context.type_data["asset_context_ids"]["videos"]
    video_contexts = [test_db.get(SubtaskContext, asset_id) for asset_id in asset_ids]
    assert aggregate_context.context_type == ContextType.EXTERNAL_WEB_CONTENT.value
    assert aggregate_context.type_data["video_count"] == 2
    assert [context.name for context in video_contexts] == [
        "Video post-1.mp4",
        "Video post-2.mp4",
    ]
    assert [context.type_data["fid"] for context in video_contexts] == [10001, 10002]
    assert [
        context.type_data["external_video_index"] for context in video_contexts
    ] == [
        0,
        1,
    ]
    assert all(
        context.type_data["storage_backend"] == "weibo" for context in video_contexts
    )


@pytest.mark.asyncio
async def test_create_context_stores_image_urls_and_creates_comment_attachment(
    monkeypatch,
    test_db,
):
    service = WebContentService()
    preview = service._build_preview(
        "https://example.com/post/1",
        [
            {
                "id": "item-1",
                "site": "xiaohongshu",
                "title": "Image post",
                "comment_count": 14,
                "images": ["https://public.example.com/a.jpg"],
                "images_s3": ["https://s3.example.com/a.jpg"],
                "comments": [
                    {"id": "comment-1", "user_name": "Alice", "content": "Great post"}
                ],
            }
        ],
    )
    uploaded: list[dict] = []

    async def fake_upload_url(url, *, uid):
        assert url == "https://public.example.com/a.jpg"
        return "image-pid-1"

    def fake_upload_attachment(**kwargs):
        uploaded.append(kwargs)
        filename = kwargs["filename"]
        context = SubtaskContext(
            subtask_id=0,
            user_id=kwargs["user_id"],
            context_type=ContextType.ATTACHMENT.value,
            name=filename,
            status=ContextStatus.READY.value,
            binary_data=b"",
            image_base64="",
            extracted_text=kwargs["binary_data"].decode("utf-8", errors="ignore"),
            text_length=len(kwargs["binary_data"]),
            error_message="",
            type_data={
                "original_filename": filename,
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
        "app.services.web_content.context_service.upload_attachment",
        fake_upload_attachment,
    )
    monkeypatch.setattr(
        "app.services.web_content.weibo_image_upload_service.upload_url",
        fake_upload_url,
    )

    user = User(id=7)
    contexts = await service.create_context(test_db, user=user, preview=preview)

    assert len(contexts) == 1
    aggregate_context = contexts[0]
    asset_ids = aggregate_context.type_data["asset_context_ids"]
    comments_context = test_db.get(SubtaskContext, asset_ids["comments"][0])
    assert aggregate_context.context_type == ContextType.EXTERNAL_WEB_CONTENT.value
    assert aggregate_context.type_data["image_count"] == 1
    assert aggregate_context.type_data["image_urls"] == [
        {
            "asset_id": "web-image-1",
            "role": "primary",
            "url": "https://public.example.com/a.jpg",
            "source_item_id": "item-1",
            "source_index": 0,
            "pid": "image-pid-1",
            "pid_status": "ready",
        }
    ]
    assert "image_pids" not in aggregate_context.type_data
    assert asset_ids == {"videos": [], "comments": [comments_context.id]}
    assert aggregate_context.type_data["comment_count"] == 14
    assert aggregate_context.type_data["fetched_comment_count"] == 1
    assert comments_context.type_data["external_media_type"] == "comments"
    assert comments_context.type_data["comment_count"] == 14
    assert comments_context.type_data["fetched_comment_count"] == 1
    assert len(uploaded) == 1
    assert b"Great post" in uploaded[0]["binary_data"]


@pytest.mark.asyncio
async def test_create_context_stores_page_text_on_aggregate_context(test_db):
    service = WebContentService()
    preview = service._build_preview(
        "https://example.com/post/1",
        [
            {
                "id": "item-1",
                "site": "example",
                "title": "Article title",
                "desc": "Article summary",
                "text": "Article body",
                "user_name": "Alice",
                "publish_time": "2026-06-17",
            }
        ],
    )

    user = User(id=7)
    contexts = await service.create_context(test_db, user=user, preview=preview)

    assert len(contexts) == 1
    aggregate_context = contexts[0]
    asset_ids = aggregate_context.type_data["asset_context_ids"]
    assert aggregate_context.context_type == ContextType.EXTERNAL_WEB_CONTENT.value
    assert aggregate_context.type_data["title"] == "Article title"
    assert aggregate_context.type_data["body"] == "Article summary\n\nArticle body"
    assert aggregate_context.type_data["author_name"] == "Alice"
    assert aggregate_context.type_data["publish_time"] == "2026-06-17"
    assert aggregate_context.type_data["video_count"] == 0
    assert asset_ids == {"videos": [], "comments": []}


def test_build_preview_uses_only_desc_and_text_for_page_body():
    service = WebContentService()
    raw_data = [
        {
            "id": "item-1",
            "title": "Article title",
            "desc": "Article summary",
            "text": "Article text",
            "content": "Content should be ignored",
            "body": "Body should be ignored",
        }
    ]

    preview = service._build_preview("https://example.com/post/1", raw_data)

    assert preview.type_data["body"] == "Article summary\n\nArticle text"


def test_build_preview_rejects_title_only_result():
    service = WebContentService()

    with pytest.raises(HTTPException) as exc_info:
        service._build_preview(
            "https://example.com/post/1",
            [
                {
                    "id": "item-1",
                    "title": "Title only",
                    "images": [],
                    "video_url": "",
                    "comments": [],
                }
            ],
        )

    assert exc_info.value.status_code == 422
    assert (
        exc_info.value.detail
        == "No supported media found in external web content result"
    )
