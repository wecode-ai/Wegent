# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for declarative Skill runtime policies."""

from types import SimpleNamespace

from app.services.execution.request_builder import TaskRequestBuilder


def test_build_skill_data_preserves_runtime_policy(test_db) -> None:
    builder = TaskRequestBuilder(test_db)
    skill = SimpleNamespace(
        id=101,
        user_id=0,
        json={
            "kind": "Skill",
            "metadata": {"name": "video-skill", "namespace": "default"},
            "spec": {
                "description": "Generate a video",
                "bindShells": ["Chat"],
                "runtime": {
                    "returnDirectTools": ["create_async_video_card"],
                },
            },
        },
    )

    skill_data = builder._build_skill_data(skill)

    assert skill_data["runtime"] == {"returnDirectTools": ["create_async_video_card"]}
