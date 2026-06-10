# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from dataclasses import dataclass

import pytest

from app.models.user import User
from app.services.web_content import WebContentService


def test_build_preview_extracts_all_videos_and_keeps_raw_data():
    service = WebContentService()
    raw_data = [
        {
            "id": "item-1",
            "site": "weibo",
            "title": "Video post",
            "content": "Post content",
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
    assert preview.type_data["normalized"]["author_name"] == "Alice"


def test_build_preview_deduplicates_videos():
    service = WebContentService()
    raw_data = [
        {"id": "item-1", "video_url_s3": "https://s3.example.com/a.mp4"},
        {"id": "item-2", "video_url_s3": "https://s3.example.com/a.mp4"},
    ]

    preview = service._build_preview("https://example.com/post/1", raw_data)

    assert preview.video_count == 1
    assert preview.type_data["videos"][0]["source_item_id"] == "item-1"


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
    assert context.name == "Video post.mp4"
    assert context.type_data["source"] == "external_web_content"
    assert "attachment_kind" not in context.type_data
    assert "video_assets" not in context.type_data
    assert context.type_data["external_source_url"] == "https://example.com/post/1"
    assert context.type_data["external_video_index"] == 0
    assert "external_original_video_url" not in context.type_data
    assert "external_origin_video_url" not in context.type_data
    assert "external_cover_url" not in context.type_data
    assert "crawl_tool" not in context.type_data
    assert "normalized" not in context.type_data
    assert "video_count" not in context.type_data
    assert "weibo_upload_request_id" not in context.type_data
    assert context.type_data["file_extension"] == ".mp4"
    assert context.type_data["storage_backend"] == "weibo"
    assert context.type_data["fid"] == 12345
    assert (
        context.type_data["raw_result"][0]["video_url_s3"]
        == "https://s3.example.com/a.mp4"
    )


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

    assert len(contexts) == 2
    assert [context.name for context in contexts] == [
        "Video post-1.mp4",
        "Video post-2.mp4",
    ]
    assert [context.type_data["fid"] for context in contexts] == [10001, 10002]
    assert [context.type_data["external_video_index"] for context in contexts] == [0, 1]
    assert all(context.type_data["storage_backend"] == "weibo" for context in contexts)
