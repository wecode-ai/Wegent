# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from types import SimpleNamespace

from app.api.endpoints.adapter.aigc_video.skill_context import (
    build_attachment_media_content,
    inject_generation_into_public_skills,
    merge_attachment_media_into_generation,
)


def test_public_skill_receives_chat_generation_settings() -> None:
    skills = [
        {
            "name": "prompts-to-movie-stepped",
            "skill_user_id": 0,
            "config": {"existing": True},
        },
        {"name": "prompts-to-movie-stepped", "skill_user_id": 7},
        {"name": "ordinary-public-skill", "skill_user_id": 0},
    ]

    inject_generation_into_public_skills(
        resolved_skills=skills,
        team_user_id=0,
        generation={"model": "happyhorse-1-0", "ratio": "16:9"},
        prompt="制作一分钟视频",
    )

    assert skills[0]["config"] == {
        "existing": True,
        "generation": {"model": "happyhorse-1-0", "ratio": "16:9"},
        "prompt": "制作一分钟视频",
    }
    assert "config" not in skills[1]
    assert "config" not in skills[2]


def test_private_team_does_not_mutate_skill_config() -> None:
    skills = [{"name": "prompts-to-movie-stepped", "skill_user_id": 0}]

    inject_generation_into_public_skills(
        resolved_skills=skills,
        team_user_id=9,
        generation={"model": "seedance-2-0-pro"},
        prompt="制作视频",
    )

    assert skills == [{"name": "prompts-to-movie-stepped", "skill_user_id": 0}]


def test_attachment_media_content_extracts_hosted_video_and_audio() -> None:
    attachments = [
        SimpleNamespace(
            type_data={
                "mime_type": "video/mp4",
                "weibo_video_upload": {"media_id": "video-123"},
            }
        ),
        SimpleNamespace(
            type_data={
                "file_extension": ".mp3",
                "weibo_audio_upload": {"media_id": "audio-456"},
            }
        ),
    ]

    assert build_attachment_media_content(attachments) == [
        {"type": "input_video", "file_id": "video-123"},
        {"type": "input_audio", "file_id": "audio-456"},
    ]


def test_attachment_media_content_merges_without_duplicates() -> None:
    generation = {
        "model": "happyhorse-1-0",
        "content": [{"type": "input_video", "file_id": "video-123"}],
    }
    attachments = [
        SimpleNamespace(
            type_data={
                "mime_type": "video/mp4",
                "weibo_video_upload": {"media_id": "video-123"},
            }
        )
    ]

    assert merge_attachment_media_into_generation(generation, attachments) == generation
