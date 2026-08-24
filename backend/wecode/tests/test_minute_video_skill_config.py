# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for one-minute-video Skill runtime configuration."""

from app.models.subtask import Subtask, SubtaskRole, SubtaskStatus
from app.models.subtask_context import SubtaskContext
from shared.models import ExecutionRequest
from shared.models.db import Kind
from wecode.service.minute_video_skill_config import (
    MINUTE_VIDEO_DURATION_SECONDS,
    inject_minute_video_skill_config,
)


def _kind(
    *,
    user_id: int,
    kind: str,
    name: str,
    resource_id: int | None = None,
    payload: dict | None = None,
) -> Kind:
    return Kind(
        id=resource_id,
        user_id=user_id,
        kind=kind,
        name=name,
        namespace="default",
        json=payload or {},
        is_active=True,
    )


def _user_subtask(
    *,
    task_id: int,
    message_id: int,
    prompt: str,
    video_config: dict | None,
) -> Subtask:
    return Subtask(
        user_id=7,
        task_id=task_id,
        team_id=11,
        title="User message",
        bot_ids=[12],
        role=SubtaskRole.USER,
        prompt=prompt,
        message_id=message_id,
        parent_id=max(0, message_id - 1),
        status=SubtaskStatus.COMPLETED,
        progress=100,
        result={"video_config": video_config} if video_config else None,
    )


def _assistant_subtask(*, task_id: int, message_id: int) -> Subtask:
    return Subtask(
        user_id=7,
        task_id=task_id,
        team_id=11,
        title="Assistant response",
        bot_ids=[12],
        role=SubtaskRole.ASSISTANT,
        prompt="",
        message_id=message_id + 1,
        parent_id=message_id,
        status=SubtaskStatus.PENDING,
        progress=0,
    )


def _context(
    *,
    subtask_id: int,
    name: str,
    mime_type: str,
    type_data: dict,
) -> SubtaskContext:
    return SubtaskContext(
        subtask_id=subtask_id,
        user_id=7,
        context_type="attachment",
        name=name,
        status="ready",
        type_data={
            "original_filename": name,
            "mime_type": mime_type,
            **type_data,
        },
    )


def _request(*, team_id: int, assistant_id: int) -> ExecutionRequest:
    return ExecutionRequest(
        task_id=101,
        subtask_id=assistant_id,
        team_id=team_id,
        bot_name="minute-video-bot",
        bot_namespace="default",
        skill_configs=[
            {
                "name": "wegent-minute-video",
                "config": {"inject_generation_context": True},
            }
        ],
    )


def test_injects_selected_video_model_params_materials_and_history(test_db) -> None:
    team = _kind(
        user_id=0,
        kind="Team",
        name="minute-video-team",
        resource_id=11,
    )
    bot = _kind(
        user_id=0,
        kind="Bot",
        name="minute-video-bot",
        resource_id=12,
        payload={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Bot",
            "metadata": {"name": "minute-video-bot", "namespace": "default"},
            "spec": {
                "ghostRef": {
                    "name": "minute-video-ghost",
                    "namespace": "default",
                },
                "modelRef": {
                    "name": "fallback-video-model",
                    "namespace": "default",
                },
                "shellRef": {"name": "Chat", "namespace": "default"},
            },
            "status": {"state": "Available"},
        },
    )
    previous = _user_subtask(
        task_id=101,
        message_id=1,
        prompt="上一轮创意",
        video_config={"model": "old-video-model", "ratio": "9:16"},
    )
    current = _user_subtask(
        task_id=101,
        message_id=3,
        prompt="制作一条夏日旅行视频",
        video_config={
            "model": "selected-video-model",
            "model_display_name": "Selected Video Model",
            "resolution": "720p",
            "ratio": "16:9",
            "duration": 15,
            "generation_mode_id": "omni_reference",
        },
    )
    assistant = _assistant_subtask(task_id=101, message_id=3)
    test_db.add_all([team, bot, previous, current, assistant])
    test_db.flush()
    test_db.add_all(
        [
            _context(
                subtask_id=previous.id,
                name="old.jpg",
                mime_type="image/jpeg",
                type_data={"image_pid": "old-image-pid"},
            ),
            _context(
                subtask_id=current.id,
                name="reference.jpg",
                mime_type="image/jpeg",
                type_data={"image_pid": "image-pid"},
            ),
            _context(
                subtask_id=current.id,
                name="reference.mp4",
                mime_type="video/mp4",
                type_data={"weibo_video_upload": {"media_id": "video-media-id"}},
            ),
            _context(
                subtask_id=current.id,
                name="voice.mp3",
                mime_type="audio/mpeg",
                type_data={"weibo_audio_upload": {"media_id": "audio-media-id"}},
            ),
        ]
    )
    test_db.flush()
    request = _request(team_id=team.id, assistant_id=assistant.id)

    inject_minute_video_skill_config(test_db, request)

    config = request.skill_configs[0]["config"]
    generation = config["generation"]
    assert config["prompt"] == "制作一条夏日旅行视频"
    assert generation["modelName"] == "selected-video-model"
    assert generation["modelDisplayName"] == "Selected Video Model"
    assert {"type": "input_image", "file_id": "image-pid"} in generation["content"]
    assert {
        "type": "input_video",
        "file_id": "video-media-id",
    } in generation["content"]
    assert {
        "type": "input_audio",
        "file_id": "audio-media-id",
    } in generation["content"]
    params = next(
        item["value"]
        for item in generation["content"]
        if item["type"] == "generate_params"
    )
    assert params == {
        "resolution": "720p",
        "ratio": "16:9",
        "generation_mode_id": "omni_reference",
        "duration": MINUTE_VIDEO_DURATION_SECONDS,
    }
    assert config["history_generation"] == [
        {
            "prompt": "上一轮创意",
            "generation": {
                "modelName": "old-video-model",
                "modelDisplayName": "old-video-model",
                "content": [
                    {"type": "input_image", "file_id": "old-image-pid"},
                    {
                        "type": "generate_params",
                        "value": {
                            "ratio": "9:16",
                            "duration": MINUTE_VIDEO_DURATION_SECONDS,
                        },
                    },
                ],
            },
        }
    ]


def test_uses_bot_primary_model_when_turn_has_no_explicit_model(test_db) -> None:
    team = _kind(
        user_id=0,
        kind="Team",
        name="minute-video-team",
        resource_id=21,
    )
    bot = _kind(
        user_id=0,
        kind="Bot",
        name="minute-video-bot",
        resource_id=22,
        payload={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Bot",
            "metadata": {"name": "minute-video-bot", "namespace": "default"},
            "spec": {
                "ghostRef": {
                    "name": "minute-video-ghost",
                    "namespace": "default",
                },
                "modelRef": {
                    "name": "default-video-model",
                    "namespace": "default",
                },
                "shellRef": {"name": "Chat", "namespace": "default"},
            },
            "status": {"state": "Available"},
        },
    )
    current = _user_subtask(
        task_id=202,
        message_id=1,
        prompt="生成视频",
        video_config={"ratio": "16:9"},
    )
    assistant = _assistant_subtask(task_id=202, message_id=1)
    test_db.add_all([team, bot, current, assistant])
    test_db.flush()
    request = _request(team_id=team.id, assistant_id=assistant.id)

    inject_minute_video_skill_config(test_db, request)

    assert (
        request.skill_configs[0]["config"]["generation"]["modelName"]
        == "default-video-model"
    )


def test_history_scan_skips_recent_non_generation_turns(test_db) -> None:
    team = _kind(
        user_id=0,
        kind="Team",
        name="minute-video-team",
        resource_id=41,
    )
    bot = _kind(
        user_id=0,
        kind="Bot",
        name="minute-video-bot",
        resource_id=42,
        payload={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Bot",
            "metadata": {"name": "minute-video-bot", "namespace": "default"},
            "spec": {
                "ghostRef": {
                    "name": "minute-video-ghost",
                    "namespace": "default",
                },
                "modelRef": {"name": "video-model", "namespace": "default"},
                "shellRef": {"name": "Chat", "namespace": "default"},
            },
            "status": {"state": "Available"},
        },
    )
    previous_generation = _user_subtask(
        task_id=404,
        message_id=1,
        prompt="上一条视频",
        video_config={"model": "history-video-model"},
    )
    ordinary_turns = [
        _user_subtask(
            task_id=404,
            message_id=message_id,
            prompt=f"普通对话 {message_id}",
            video_config=None,
        )
        for message_id in (3, 5, 7, 9, 11)
    ]
    current = _user_subtask(
        task_id=404,
        message_id=13,
        prompt="继续生成",
        video_config={"model": "video-model"},
    )
    assistant = _assistant_subtask(task_id=404, message_id=13)
    test_db.add_all(
        [team, bot, previous_generation, *ordinary_turns, current, assistant]
    )
    test_db.flush()
    request = _request(team_id=team.id, assistant_id=assistant.id)

    inject_minute_video_skill_config(test_db, request)

    assert request.skill_configs[0]["config"]["history_generation"] == [
        {
            "prompt": "上一条视频",
            "generation": {
                "modelName": "history-video-model",
                "modelDisplayName": "history-video-model",
                "content": [
                    {
                        "type": "generate_params",
                        "value": {"duration": MINUTE_VIDEO_DURATION_SECONDS},
                    }
                ],
            },
        }
    ]


def test_reports_media_without_qia_identifier(test_db) -> None:
    team = _kind(
        user_id=0,
        kind="Team",
        name="minute-video-team",
        resource_id=31,
    )
    bot = _kind(
        user_id=0,
        kind="Bot",
        name="minute-video-bot",
        resource_id=32,
        payload={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Bot",
            "metadata": {"name": "minute-video-bot", "namespace": "default"},
            "spec": {
                "ghostRef": {
                    "name": "minute-video-ghost",
                    "namespace": "default",
                },
                "modelRef": {"name": "video-model", "namespace": "default"},
                "shellRef": {"name": "Chat", "namespace": "default"},
            },
            "status": {"state": "Available"},
        },
    )
    current = _user_subtask(
        task_id=303,
        message_id=1,
        prompt="使用素材生成视频",
        video_config={"model": "video-model"},
    )
    assistant = _assistant_subtask(task_id=303, message_id=1)
    test_db.add_all([team, bot, current, assistant])
    test_db.flush()
    test_db.add(
        _context(
            subtask_id=current.id,
            name="broken.mp4",
            mime_type="video/mp4",
            type_data={},
        )
    )
    test_db.flush()
    request = _request(team_id=team.id, assistant_id=assistant.id)

    inject_minute_video_skill_config(test_db, request)

    assert request.skill_configs[0]["config"]["material_errors"] == [
        {
            "attachment_id": current.contexts[0].id,
            "name": "broken.mp4",
            "reason": "missing_video_id",
        }
    ]


def test_does_not_modify_skills_without_opt_in(test_db) -> None:
    request = ExecutionRequest(
        subtask_id=999,
        skill_configs=[{"name": "ordinary-skill", "config": {}}],
    )

    inject_minute_video_skill_config(test_db, request)

    assert request.skill_configs == [{"name": "ordinary-skill", "config": {}}]
