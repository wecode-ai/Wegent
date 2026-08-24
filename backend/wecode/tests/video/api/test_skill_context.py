# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from types import SimpleNamespace

from wecode.video.api.skill_context import (
    build_attachment_media_content,
    filter_prior_user_attachments,
    inherit_attachment_media_into_generation,
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
        {"name": "material-to-video-unified-async", "skill_user_id": 0},
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
    assert skills[1]["config"] == {
        "generation": {"model": "happyhorse-1-0", "ratio": "16:9"},
        "prompt": "制作一分钟视频",
    }
    assert "config" not in skills[2]
    assert "config" not in skills[3]


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
        SimpleNamespace(
            type_data={
                "mime_type": "image/jpeg",
                "image_pid": "image-789",
            }
        ),
    ]

    assert build_attachment_media_content(attachments) == [
        {"type": "input_video", "file_id": "video-123"},
        {"type": "input_audio", "file_id": "audio-456"},
        {"type": "input_image", "file_id": "image-789"},
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


def test_attachment_free_follow_up_inherits_task_media() -> None:
    task_attachments = [
        SimpleNamespace(
            type_data={
                "mime_type": "image/png",
                "image_pid": "image-from-first-turn",
            }
        )
    ]

    assert inherit_attachment_media_into_generation(
        {"ratio": "9:16"},
        current_attachments=[],
        task_attachments=task_attachments,
    ) == {
        "ratio": "9:16",
        "content": [{"type": "input_image", "file_id": "image-from-first-turn"}],
    }


def test_current_turn_media_does_not_reuse_previous_task_media() -> None:
    current_attachments = [
        SimpleNamespace(
            type_data={
                "mime_type": "image/png",
                "image_pid": "current-image",
            }
        )
    ]
    task_attachments = current_attachments + [
        SimpleNamespace(
            type_data={
                "mime_type": "image/png",
                "image_pid": "previous-image",
            }
        )
    ]

    assert inherit_attachment_media_into_generation(
        None,
        current_attachments=current_attachments,
        task_attachments=task_attachments,
    ) == {"content": [{"type": "input_image", "file_id": "current-image"}]}


def test_invalid_current_visual_media_does_not_reuse_previous_task_media() -> None:
    current_attachments = [SimpleNamespace(type_data={"mime_type": "image/webp"})]
    task_attachments = [
        SimpleNamespace(
            type_data={
                "mime_type": "image/png",
                "image_pid": "previous-image",
            }
        )
    ]

    assert (
        inherit_attachment_media_into_generation(
            None,
            current_attachments=current_attachments,
            task_attachments=task_attachments,
        )
        is None
    )


def test_inherited_media_is_limited_to_prior_turns_from_current_user() -> None:
    attachments = [
        SimpleNamespace(user_id=7, subtask_id=10),
        SimpleNamespace(user_id=8, subtask_id=11),
        SimpleNamespace(user_id=7, subtask_id=12),
        SimpleNamespace(user_id=7, subtask_id=13),
    ]

    assert filter_prior_user_attachments(
        attachments,
        current_subtask_id=13,
        user_id=7,
    ) == [attachments[0], attachments[2]]
