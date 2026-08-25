# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from chat_shell.skills.context import SkillToolContext


def test_skill_tool_context_repr_excludes_auth_tokens() -> None:
    context = SkillToolContext(
        task_id=1,
        subtask_id=2,
        user_id=3,
        db_session=None,
        ws_emitter=None,
        auth_token="task-secret-token",
        skill_identity_token="skill-secret-token",
    )

    representation = repr(context)

    assert "task-secret-token" not in representation
    assert "skill-secret-token" not in representation
    assert "auth_token=" not in representation
    assert "skill_identity_token=" not in representation
    assert context.auth_token == "task-secret-token"
    assert context.skill_identity_token == "skill-secret-token"
