# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import json
from datetime import datetime, timezone

from app.schemas.user import UserInDB


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
