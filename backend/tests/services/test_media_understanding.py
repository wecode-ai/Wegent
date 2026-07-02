# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import asyncio
import importlib

from app.core.config import settings
from app.mcp_server.auth import TaskTokenInfo
from app.models.kind import Kind
from app.models.resource_member import MemberStatus, ResourceMember
from app.models.share_link import ResourceType
from app.models.subtask import Subtask
from app.models.subtask_context import ContextStatus, ContextType, SubtaskContext
from app.models.task import TaskResource
from app.services.media_understanding.service import (
    MediaUnderstandingClient,
    MediaUnderstandingService,
)

context_service_module = importlib.import_module("app.services.context.context_service")


class FakeMediaUnderstandingClient:
    def __init__(self):
        self.calls = []

    async def understand_media(
        self,
        *,
        model_config,
        media_type,
        media_url,
        image_base64,
        mime_type,
        question,
        instruction,
        context,
    ):
        self.calls.append(
            {
                "model_config": model_config,
                "media_type": media_type,
                "media_url": media_url,
                "image_base64": image_base64,
                "mime_type": mime_type,
                "question": question,
                "instruction": instruction,
                "context": context,
            }
        )
        return "画面显示有人在室内展示商品。"


def _token_info(test_user, *, task_id=101, subtask_id=201):
    return TaskTokenInfo(
        task_id=task_id,
        subtask_id=subtask_id,
        user_id=test_user.id,
        user_name=test_user.user_name,
    )


def _create_video_context(test_db, test_user, *, subtask_id=0, fid="fid-1"):
    context = SubtaskContext(
        subtask_id=subtask_id,
        user_id=test_user.id,
        context_type=ContextType.ATTACHMENT.value,
        name="demo.mp4",
        status=ContextStatus.READY.value,
        binary_data=b"",
        image_base64="",
        extracted_text="",
        text_length=0,
        type_data={
            "original_filename": "demo.mp4",
            "file_extension": ".mp4",
            "file_size": 1024,
            "mime_type": "video/mp4",
            "storage_backend": "weibo",
            "storage_key": "",
            "fid": fid,
        },
    )
    test_db.add(context)
    test_db.commit()
    test_db.refresh(context)
    return context


def _create_image_context(
    test_db,
    test_user,
    *,
    subtask_id=0,
    image_base64="aW1hZ2UtYnl0ZXM=",
    mime_type="image/png",
):
    context = SubtaskContext(
        subtask_id=subtask_id,
        user_id=test_user.id,
        context_type=ContextType.ATTACHMENT.value,
        name="demo.png",
        status=ContextStatus.READY.value,
        binary_data=b"",
        image_base64=image_base64,
        extracted_text="",
        text_length=0,
        type_data={
            "original_filename": "demo.png",
            "file_extension": ".png",
            "file_size": 1024,
            "mime_type": mime_type,
            "storage_backend": "mysql",
            "storage_key": "",
        },
    )
    test_db.add(context)
    test_db.commit()
    test_db.refresh(context)
    return context


def _create_public_media_understanding_model(test_db, monkeypatch):
    model = Kind(
        user_id=0,
        kind="Model",
        name="media-understanding-video",
        namespace="default",
        is_active=True,
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Model",
            "metadata": {"name": "media-understanding-video", "namespace": "default"},
            "spec": {
                "modelConfig": {
                    "env": {
                        "model": "anthropic",
                        "model_id": "fixed-video-model",
                        "api_key": "plain-test-key",
                        "base_url": "https://llm.example.com",
                    },
                    "DEFAULT_HEADERS": {
                        "X-User": "${user.name}",
                        "X-User-Id": "${user.id}",
                        "X-Task-User": "${task_data.user.name}",
                    },
                    "max_output_tokens": 2048,
                }
            },
        },
    )
    test_db.add(model)
    test_db.commit()
    test_db.refresh(model)
    monkeypatch.setattr(settings, "MEDIA_UNDERSTANDING_MODEL_KIND_ID", model.id)
    return model


def _create_text_context(test_db, test_user):
    context = SubtaskContext(
        subtask_id=0,
        user_id=test_user.id,
        context_type=ContextType.ATTACHMENT.value,
        name="note.txt",
        status=ContextStatus.READY.value,
        binary_data=b"",
        image_base64="",
        extracted_text="hello",
        text_length=5,
        type_data={
            "original_filename": "note.txt",
            "file_extension": ".txt",
            "file_size": 5,
            "mime_type": "text/plain",
            "storage_backend": "mysql",
            "storage_key": "",
        },
    )
    test_db.add(context)
    test_db.commit()
    test_db.refresh(context)
    return context


def test_understand_media_resolves_video_context(monkeypatch, test_db, test_user):
    _create_public_media_understanding_model(test_db, monkeypatch)
    context = _create_video_context(test_db, test_user)
    client = FakeMediaUnderstandingClient()
    service = MediaUnderstandingService(client=client)

    monkeypatch.setattr(
        context_service_module.weibo_media_service,
        "get_download_url",
        lambda fid, user=None: "https://cdn.example.com/video.mp4",
    )

    result = service.understand_media(
        test_db,
        token_info=_token_info(test_user),
        context_id=context.id,
        media_type="video",
        question="画面里有什么？",
        instruction="重点看商品",
        context={
            "title": "商品介绍",
            "description": "背景描述",
            "ignored": "not passed",
        },
    )

    assert result["status"] == "success"
    assert result["source"] == "attachment"
    assert result["model"] == "fixed-video-model"
    assert result["answer"] == "画面显示有人在室内展示商品。"
    assert client.calls == [
        {
            "model_config": {
                "api_key": "plain-test-key",
                "base_url": "https://llm.example.com",
                "model_id": "fixed-video-model",
                "model": "anthropic",
                "default_headers": {
                    "X-User": test_user.user_name,
                    "X-User-Id": str(test_user.id),
                    "X-Task-User": test_user.user_name,
                },
                "api_format": None,
                "protocol": None,
                "context_window": None,
                "max_output_tokens": 2048,
                "modelType": None,
                "videoConfig": None,
                "think_config": None,
                "temperature": None,
                "supports_developer_role": None,
                "model_name": "media-understanding-video",
                "model_namespace": "default",
            },
            "media_type": "video",
            "media_url": "https://cdn.example.com/video.mp4",
            "image_base64": "",
            "mime_type": "",
            "question": "画面里有什么？",
            "instruction": "重点看商品",
            "context": {"title": "商品介绍", "description": "背景描述"},
        }
    ]


def test_attachment_id_alias_resolves_video(monkeypatch, test_db, test_user):
    _create_public_media_understanding_model(test_db, monkeypatch)
    context = _create_video_context(test_db, test_user)
    client = FakeMediaUnderstandingClient()
    service = MediaUnderstandingService(client=client)
    monkeypatch.setattr(
        context_service_module.weibo_media_service,
        "get_download_url",
        lambda fid, user=None: "https://cdn.example.com/video.mp4",
    )

    result = service.understand_media(
        test_db,
        token_info=_token_info(test_user),
        attachment_id=context.id,
        media_type="video",
    )

    assert result["status"] == "success"
    assert client.calls[0]["media_url"] == "https://cdn.example.com/video.mp4"
    assert client.calls[0]["model_config"]["default_headers"] == {
        "X-User": test_user.user_name,
        "X-User-Id": str(test_user.id),
        "X-Task-User": test_user.user_name,
    }


def test_understand_media_resolves_image_context(monkeypatch, test_db, test_user):
    _create_public_media_understanding_model(test_db, monkeypatch)
    context = _create_image_context(test_db, test_user)
    client = FakeMediaUnderstandingClient()
    service = MediaUnderstandingService(client=client)

    result = service.understand_media(
        test_db,
        token_info=_token_info(test_user),
        attachment_id=context.id,
        media_type="image",
        question="图片里有什么？",
    )

    assert result["status"] == "success"
    assert result["source"] == "attachment"
    assert client.calls[0]["media_type"] == "image"
    assert client.calls[0]["media_url"] == ""
    assert client.calls[0]["image_base64"] == "aW1hZ2UtYnl0ZXM="
    assert client.calls[0]["mime_type"] == "image/png"


def test_image_context_without_payload_returns_image_payload_unavailable(
    test_db, test_user
):
    context = _create_image_context(test_db, test_user, image_base64="")
    client = FakeMediaUnderstandingClient()
    service = MediaUnderstandingService(client=client)

    result = service.understand_media(
        test_db,
        token_info=_token_info(test_user),
        attachment_id=context.id,
        media_type="image",
    )

    assert result["status"] == "error"
    assert result["error_code"] == "image_payload_unavailable"
    assert client.calls == []


def test_image_media_url_is_supported(monkeypatch, test_db, test_user):
    _create_public_media_understanding_model(test_db, monkeypatch)
    client = FakeMediaUnderstandingClient()
    service = MediaUnderstandingService(client=client)

    result = service.understand_media(
        test_db,
        token_info=_token_info(test_user),
        media_url="https://cdn.example.com/image.png",
        media_type="image",
    )

    assert result["status"] == "success"
    assert result["source"] == "media_url"
    assert client.calls[0]["media_type"] == "image"
    assert client.calls[0]["media_url"] == "https://cdn.example.com/image.png"
    assert client.calls[0]["image_base64"] == ""


def test_attachment_bound_to_current_task_subtask_is_accessible(
    monkeypatch, test_db, test_user
):
    _create_public_media_understanding_model(test_db, monkeypatch)
    user_message_subtask = Subtask(
        id=302,
        user_id=999,
        task_id=101,
        team_id=1,
        title="user message",
        bot_ids=[],
    )
    test_db.add(user_message_subtask)
    test_db.commit()
    context = _create_video_context(
        test_db,
        test_user,
        subtask_id=user_message_subtask.id,
    )
    client = FakeMediaUnderstandingClient()
    service = MediaUnderstandingService(client=client)
    monkeypatch.setattr(
        context_service_module.weibo_media_service,
        "get_download_url",
        lambda fid, user=None: "https://cdn.example.com/video.mp4",
    )

    result = service.understand_media(
        test_db,
        token_info=_token_info(test_user, task_id=101, subtask_id=303),
        attachment_id=context.id,
        media_type="video",
    )

    assert result["status"] == "success"
    assert client.calls[0]["media_url"] == "https://cdn.example.com/video.mp4"


def test_video_client_forwards_default_headers():
    client = MediaUnderstandingClient()

    headers = client._build_headers(
        {
            "api_key": "secret",
            "default_headers": {
                "X-User": "alice",
                "X-User-Id": 42,
            },
        }
    )

    assert headers["x-api-key"] == "secret"
    assert headers["X-User"] == "alice"
    assert headers["X-User-Id"] == "42"


def test_media_client_prompt_uses_upstream_question_and_instruction():
    client = MediaUnderstandingClient()

    payload = client._build_payload(
        model_config={"model_id": "fixed-media-model", "max_tokens": 123},
        media_type="video",
        media_url="https://cdn.example.com/video.mp4",
        image_base64="",
        mime_type="",
        question="请结合声音和画面判断这个视频在讲什么",
        instruction="以上游问题为主，不要输出 JSON",
        context={"title": "发布标题", "description": "发布描述"},
    )

    system_prompt = payload["system"]
    text_block = payload["messages"][0]["content"][1]["text"]

    assert payload["messages"][0]["content"][0] == {
        "type": "video",
        "source": {"type": "url", "url": "https://cdn.example.com/video.mp4"},
    }
    assert payload["model"] == "fixed-media-model"
    assert payload["max_tokens"] == 123
    assert "Follow the user's question and analysis instruction" in system_prompt
    assert "Use any media modalities" in system_prompt
    assert "JSON" not in system_prompt
    assert "visible video content" not in system_prompt
    assert "请结合声音和画面判断这个视频在讲什么" in text_block
    assert "以上游问题为主，不要输出 JSON" in text_block
    assert "发布标题" in text_block
    assert "发布描述" in text_block
    assert "Return a concise natural-language answer." in text_block
    assert "Return concise JSON" not in text_block


def test_media_client_builds_image_base64_payload():
    client = MediaUnderstandingClient()

    payload = client._build_payload(
        model_config={"model_id": "fixed-media-model", "max_tokens": 123},
        media_type="image",
        media_url="",
        image_base64="aW1hZ2U=",
        mime_type="image/png",
        question="图片里有什么？",
        instruction="",
        context={},
    )

    assert payload["messages"][0]["content"][0] == {
        "type": "image",
        "source": {
            "type": "base64",
            "media_type": "image/png",
            "data": "aW1hZ2U=",
        },
    }


def test_media_client_uses_max_output_tokens_from_resolved_model_config():
    client = MediaUnderstandingClient()

    payload = client._build_payload(
        model_config={"model_id": "fixed-media-model", "max_output_tokens": 2048},
        media_type="video",
        media_url="https://cdn.example.com/video.mp4",
        image_base64="",
        mime_type="",
        question="请分析视频",
        instruction="",
        context={},
    )

    assert payload["max_tokens"] == 2048


def test_media_client_extracts_natural_language_answer():
    text = MediaUnderstandingClient._extract_text(
        {
            "content": [
                {"type": "text", "text": "这段视频展示了产品开箱。"},
                {"type": "text", "text": "声音中提到了主要卖点。"},
            ]
        }
    )

    assert text == "这段视频展示了产品开箱。\n声音中提到了主要卖点。"


def test_missing_model_kind_id_returns_configuration_error(
    monkeypatch, test_db, test_user
):
    monkeypatch.setattr(settings, "MEDIA_UNDERSTANDING_MODEL_KIND_ID", 0)
    service = MediaUnderstandingService(client=FakeMediaUnderstandingClient())

    result = service.understand_media(
        test_db,
        token_info=_token_info(test_user),
        media_url="https://cdn.example.com/video.mp4",
        media_type="video",
    )

    assert result["status"] == "error"
    assert result["error_code"] == "configuration_error"
    assert "MEDIA_UNDERSTANDING_MODEL_KIND_ID" in result["error_message"]


def test_non_video_context_returns_unsupported_media_type(test_db, test_user):
    context = _create_text_context(test_db, test_user)
    service = MediaUnderstandingService(client=FakeMediaUnderstandingClient())

    result = service.understand_media(
        test_db,
        token_info=_token_info(test_user),
        context_id=context.id,
        media_type="video",
    )

    assert result["status"] == "error"
    assert result["error_code"] == "unsupported_media_type"


def test_missing_fid_returns_video_url_unavailable(test_db, test_user):
    context = _create_video_context(test_db, test_user, fid="")
    service = MediaUnderstandingService(client=FakeMediaUnderstandingClient())

    result = service.understand_media(
        test_db,
        token_info=_token_info(test_user),
        context_id=context.id,
        media_type="video",
    )

    assert result["status"] == "error"
    assert result["error_code"] == "video_url_unavailable"


def test_multiple_sources_return_invalid_argument(test_db, test_user):
    context = _create_video_context(test_db, test_user)
    service = MediaUnderstandingService(client=FakeMediaUnderstandingClient())

    result = service.understand_media(
        test_db,
        token_info=_token_info(test_user),
        context_id=context.id,
        media_url="https://cdn.example.com/video.mp4",
        media_type="video",
    )

    assert result["status"] == "error"
    assert result["error_code"] == "invalid_argument"


def test_non_http_media_url_returns_invalid_media_url(test_db, test_user):
    service = MediaUnderstandingService(client=FakeMediaUnderstandingClient())

    result = service.understand_media(
        test_db,
        token_info=_token_info(test_user),
        media_url="file:///tmp/video.mp4",
        media_type="video",
    )

    assert result["status"] == "error"
    assert result["error_code"] == "invalid_media_url"


def test_context_bound_to_another_task_can_be_used_by_internal_mcp(
    monkeypatch, test_db, test_user
):
    _create_public_media_understanding_model(test_db, monkeypatch)
    subtask = Subtask(
        id=301,
        user_id=test_user.id,
        task_id=999,
        team_id=1,
        title="other task",
        bot_ids=[],
    )
    test_db.add(subtask)
    test_db.commit()
    context = _create_video_context(test_db, test_user, subtask_id=subtask.id)
    client = FakeMediaUnderstandingClient()
    service = MediaUnderstandingService(client=client)
    monkeypatch.setattr(
        context_service_module.weibo_media_service,
        "get_download_url",
        lambda fid, user=None: "https://cdn.example.com/video.mp4",
    )

    result = service.understand_media(
        test_db,
        token_info=_token_info(test_user, task_id=101),
        context_id=context.id,
        media_type="video",
    )

    assert result["status"] == "success"
    assert client.calls[0]["media_url"] == "https://cdn.example.com/video.mp4"


def test_task_member_can_use_attachment_from_task(monkeypatch, test_db, test_user):
    _create_public_media_understanding_model(test_db, monkeypatch)
    task = TaskResource(
        id=401,
        user_id=test_user.id + 1,
        kind="Task",
        name="shared-task",
        namespace="default",
        json={"spec": {}},
        is_active=TaskResource.STATE_ACTIVE,
    )
    subtask = Subtask(
        id=402,
        user_id=test_user.id + 1,
        task_id=task.id,
        team_id=1,
        title="shared user message",
        bot_ids=[],
    )
    member = ResourceMember(
        resource_type=ResourceType.TASK,
        resource_id=task.id,
        entity_type="user",
        entity_id=str(test_user.id),
        role="Reporter",
        status=MemberStatus.APPROVED,
    )
    test_db.add_all([task, subtask, member])
    test_db.commit()
    context = _create_video_context(
        test_db,
        test_user,
        subtask_id=subtask.id,
    )
    context.user_id = test_user.id + 1
    test_db.add(context)
    test_db.commit()
    client = FakeMediaUnderstandingClient()
    service = MediaUnderstandingService(client=client)
    monkeypatch.setattr(
        context_service_module.weibo_media_service,
        "get_download_url",
        lambda fid, user=None: "https://cdn.example.com/video.mp4",
    )

    result = service.understand_media(
        test_db,
        token_info=_token_info(test_user, task_id=101),
        context_id=context.id,
        media_type="video",
    )

    assert result["status"] == "success"
    assert client.calls[0]["media_url"] == "https://cdn.example.com/video.mp4"


def test_unlinked_context_from_another_user_is_not_accessible(
    monkeypatch, test_db, test_user
):
    _create_public_media_understanding_model(test_db, monkeypatch)
    other_user_context = _create_video_context(test_db, test_user)
    other_user_context.user_id = test_user.id + 1
    test_db.add(other_user_context)
    test_db.commit()
    client = FakeMediaUnderstandingClient()
    service = MediaUnderstandingService(client=client)
    monkeypatch.setattr(
        context_service_module.weibo_media_service,
        "get_download_url",
        lambda fid, user=None: "https://cdn.example.com/video.mp4",
    )

    result = service.understand_media(
        test_db,
        token_info=_token_info(test_user),
        context_id=other_user_context.id,
        media_type="video",
    )

    assert result["status"] == "error"
    assert result["error_code"] == "context_not_found"
    assert client.calls == []


def test_understand_media_can_run_inside_existing_event_loop(
    monkeypatch, test_db, test_user
):
    _create_public_media_understanding_model(test_db, monkeypatch)
    client = FakeMediaUnderstandingClient()
    service = MediaUnderstandingService(client=client)

    async def run_in_event_loop():
        return service.understand_media(
            test_db,
            token_info=_token_info(test_user),
            media_url="https://cdn.example.com/video.mp4",
            media_type="video",
            question="画面里有什么？",
        )

    result = asyncio.run(run_in_event_loop())

    assert result["status"] == "success"
    assert client.calls[0]["media_url"] == "https://cdn.example.com/video.mp4"
