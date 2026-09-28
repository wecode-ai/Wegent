# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import json
from datetime import datetime, timezone

import pytest
from pydantic import ValidationError

from app.schemas.user import UserInDB, UserPreferences


def test_user_preferences_accept_runtime_model_selection():
    user = UserInDB(
        id=1,
        user_name="admin",
        email="admin@example.com",
        preferences=json.dumps(
            {
                "wework_new_chat_model_selection": {
                    "modelName": "codex-gpt-5.5",
                    "modelType": "runtime",
                    "options": {"reasoning": "medium"},
                }
            }
        ),
        created_at=datetime.now(timezone.utc),
        updated_at=datetime.now(timezone.utc),
    )

    assert user.preferences is not None
    assert user.preferences.wework_new_chat_model_selection is not None
    assert user.preferences.wework_new_chat_model_selection.modelType == "runtime"


def test_user_preferences_accept_per_project_work_preferences() -> None:
    user = UserInDB(
        id=1,
        user_name="admin",
        email="admin@example.com",
        preferences=json.dumps(
            {
                "wework_project_work_preferences": {
                    "project:7": {
                        "executionMode": "git_worktree",
                        "worktreeBranch": "feature/alpha",
                    }
                }
            }
        ),
        created_at=datetime.now(timezone.utc),
        updated_at=datetime.now(timezone.utc),
    )

    assert user.preferences is not None
    preference = user.preferences.wework_project_work_preferences["project:7"]
    assert preference.executionMode == "git_worktree"
    assert preference.worktreeBranch == "feature/alpha"


def test_composer_preferences_preserve_modes_attachments_and_explicit_empty() -> None:
    phrases = [
        {"id": "plan", "title": " Plan ", "content": " Review ", "mode": "plan"},
        {
            "id": "stash-file",
            "title": "File",
            "content": "",
            "mode": "normal",
            "attachmentPaths": ["/tmp/a.png"],
            "createdAt": 123,
        },
    ]
    preferences = UserPreferences(composer_quick_phrases=phrases)
    restored = UserPreferences.model_validate_json(preferences.model_dump_json())
    assert restored.composer_quick_phrases[0].content == "Review"
    assert restored.composer_quick_phrases[1].attachmentPaths == ["/tmp/a.png"]
    assert UserPreferences(composer_quick_phrases=[]).model_dump(
        exclude_unset=True
    ) == {"composer_quick_phrases": []}


@pytest.mark.parametrize(
    "change", [{"mode": "unknown"}, {"content": " "}, {"title": " "}]
)
def test_composer_preferences_reject_invalid_phrases(change: dict) -> None:
    phrase = {
        "id": "summary",
        "title": "Summary",
        "content": "Summarize",
        "mode": "normal",
        **change,
    }
    with pytest.raises(ValidationError):
        UserPreferences(composer_quick_phrases=[phrase])
