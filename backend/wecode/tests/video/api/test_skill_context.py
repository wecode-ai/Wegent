# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from types import SimpleNamespace
from urllib.parse import parse_qs, urlsplit

from app.services.attachment.public_link import verify_public_attachment_token
from app.services.execution.skill_generation import (
    apply_skill_generation_to_skills,
    enrich_skill_generation_context,
)
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

    apply_skill_generation_to_skills(
        resolved_skills=skills,
        team_user_id=0,
        generation={
            "model": "happyhorse-1-0",
            "model_display_name": "HappyHorse 1.0",
            "resolution": "720p",
            "ratio": "16:9",
            "generation_mode_id": "omni_reference",
            "content": [
                {"type": "input_image", "file_id": "image-pid"},
                {"type": "input_video", "file_id": "video-media-id"},
            ],
        },
        prompt="制作一分钟视频",
    )

    generation = {
        "modelName": "happyhorse-1-0",
        "modelDisplayName": "HappyHorse 1.0",
        "content": [
            {"type": "input_image", "file_id": "image-pid"},
            {"type": "input_video", "file_id": "video-media-id"},
            {
                "type": "generate_params",
                "value": {
                    "resolution": "720p",
                    "ratio": "16:9",
                    "generation_mode_id": "omni_reference",
                },
            },
        ],
    }
    assert skills[0]["config"] == {
        "existing": True,
        "generation": generation,
        "prompt": "制作一分钟视频",
    }
    assert skills[1]["config"] == {
        "generation": generation,
        "prompt": "制作一分钟视频",
    }
    assert "config" not in skills[2]
    assert "config" not in skills[3]


def test_private_team_does_not_mutate_skill_config() -> None:
    skills = [{"name": "prompts-to-movie-stepped", "skill_user_id": 0}]

    apply_skill_generation_to_skills(
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


def test_attachment_media_content_uses_signed_url_for_local_image(
    monkeypatch,
) -> None:
    monkeypatch.setattr(
        "wecode.video.api.skill_context.settings.WEGENT_BACKEND_PUBLIC_URL",
        "http://10.218.17.35:8500",
    )
    attachments = [
        SimpleNamespace(
            id=14,
            type_data={
                "mime_type": "image/png",
                "image_pid_status": "failed",
            },
        )
    ]

    content = build_attachment_media_content(attachments)

    assert len(content) == 1
    assert content[0]["type"] == "input_image"
    assert content[0]["file_id"] == "wegent-attachment-14"
    assert content[0]["image_source"] == "wegent_attachment_url"
    parsed = urlsplit(content[0]["image_url"])
    assert parsed.netloc == "10.218.17.35:8500"
    assert parsed.path == "/api/attachments/download/shared"
    token = parse_qs(parsed.query)["token"][0]
    assert verify_public_attachment_token(token)["attachment_id"] == 14


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


def test_registered_enricher_limits_inherited_media_to_prior_user_turns() -> None:
    task_attachments = [
        SimpleNamespace(
            user_id=7,
            subtask_id=10,
            type_data={"mime_type": "image/png", "image_pid": "prior-image"},
        ),
        SimpleNamespace(
            user_id=8,
            subtask_id=11,
            type_data={"mime_type": "image/png", "image_pid": "other-user"},
        ),
    ]

    assert enrich_skill_generation_context(
        generation={"ratio": "9:16"},
        current_attachments=[],
        task_attachments=task_attachments,
        current_subtask_id=12,
        user_id=7,
    ) == {
        "ratio": "9:16",
        "content": [{"type": "input_image", "file_id": "prior-image"}],
    }
