# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for IM control skill injection in task request building."""

from types import SimpleNamespace

from app.services.auth.task_token import verify_task_token
from app.services.execution.request_builder import TaskRequestBuilder


def _task_with_im_context() -> SimpleNamespace:
    return SimpleNamespace(
        id=17,
        json={
            "spec": {
                "im_context": {
                    "session_key": "session-17",
                    "channel_id": 42,
                }
            }
        },
    )


def test_injects_im_control_skill_for_im_context_task():
    result = TaskRequestBuilder._inject_im_control_skill([], _task_with_im_context())

    assert result == [
        {
            "name": "im-control",
            "namespace": "default",
            "is_public": True,
        }
    ]


def test_does_not_duplicate_im_control_skill():
    preload_skills = ["im-control"]

    result = TaskRequestBuilder._inject_im_control_skill(
        preload_skills,
        _task_with_im_context(),
    )

    assert result == preload_skills


def test_task_token_includes_im_context_from_task():
    builder = TaskRequestBuilder.__new__(TaskRequestBuilder)
    token = builder._generate_auth_token(
        task=_task_with_im_context(),
        subtask=SimpleNamespace(id=29),
        user=SimpleNamespace(id=31, user_name="alice"),
    )

    token_info = verify_task_token(token)

    assert token_info is not None
    assert token_info.im_session_key == "session-17"
    assert token_info.im_channel_id == 42
