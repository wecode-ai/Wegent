# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import pytest
from fastapi import HTTPException

from app.schemas.bot import BotUpdate
from app.services.adapters.bot_kinds import bot_kinds_service
from tests.services.adapters.test_bot_kinds_permissions import (
    group_agent as group_agent,
)


def test_unresolved_shell_cannot_rebind_to_owner_private_shell(
    test_db, test_user, group_agent
):
    """An unchanged name cannot authorize a different private Shell namespace."""
    _, team, bot, ghost, _ = group_agent
    original_ref = {"name": "ClaudeCode", "namespace": "removed-shell-group"}
    bot.json = {
        **bot.json,
        "spec": {**bot.json["spec"], "shellRef": original_ref},
    }
    test_db.commit()
    original_prompt = ghost.json["spec"]["systemPrompt"]

    with pytest.raises(HTTPException) as exc_info:
        bot_kinds_service.update_with_user(
            test_db,
            bot_id=bot.id,
            user_id=test_user.id,
            obj_in=BotUpdate(
                team_id=team.id,
                shell_name="ClaudeCode",
                system_prompt="Invalid Shell replacement must not persist",
            ),
        )

    assert exc_info.value.status_code == 403
    test_db.refresh(bot)
    test_db.refresh(ghost)
    assert bot.json["spec"]["shellRef"] == original_ref
    assert ghost.json["spec"]["systemPrompt"] == original_prompt
