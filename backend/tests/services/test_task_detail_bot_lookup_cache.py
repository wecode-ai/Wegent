# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from datetime import datetime
from types import SimpleNamespace
from unittest.mock import Mock, patch

import pytest
from sqlalchemy.orm import Session

from app.services.adapters.task_kinds.task_detail_helpers import get_bots_for_subtasks
from app.services.readers.kinds import KindType


def _build_bot(bot_id: int) -> SimpleNamespace:
    now = datetime.now()
    return SimpleNamespace(
        id=bot_id,
        user_id=10,
        name=f"bot-{bot_id}",
        json={"kind": "Bot"},
        is_active=True,
        created_at=now,
        updated_at=now,
    )


@pytest.mark.unit
def test_get_bots_for_subtasks_caches_shared_model_and_shell_queries():
    db = Mock(spec=Session)
    bot_objects = [_build_bot(1), _build_bot(2)]

    bot_crd = SimpleNamespace(
        spec=SimpleNamespace(
            modelRef=SimpleNamespace(namespace="default", name="shared-model"),
            shellRef=SimpleNamespace(namespace="default", name="shared-shell"),
        )
    )
    shell_crd = SimpleNamespace(spec=SimpleNamespace(shellType="ClaudeCode"))
    model_kind = SimpleNamespace(user_id=10)
    shell_kind = SimpleNamespace(json={"kind": "Shell"})

    def _lookup_side_effect(_db, _user_id, kind, _namespace, _name):
        if kind == KindType.MODEL:
            return model_kind
        if kind == KindType.SHELL:
            return shell_kind
        return None

    with (
        patch(
            "app.services.readers.kinds.kindReader.get_by_ids", return_value=bot_objects
        ),
        patch(
            "app.services.adapters.task_kinds.task_detail_helpers.Bot.model_validate",
            return_value=bot_crd,
        ),
        patch(
            "app.services.adapters.task_kinds.task_detail_helpers.Shell.model_validate",
            return_value=shell_crd,
        ),
        patch(
            "app.services.readers.kinds.kindReader.get_by_name_and_namespace",
            side_effect=_lookup_side_effect,
        ) as mock_lookup,
    ):
        result = get_bots_for_subtasks(db, {1, 2})

    assert len(result) == 2
    assert result[1]["agent_config"]["bind_model"] == "shared-model"
    assert result[1]["shell_type"] == "ClaudeCode"
    assert result[2]["agent_config"]["bind_model"] == "shared-model"
    assert result[2]["shell_type"] == "ClaudeCode"
    assert mock_lookup.call_count == 2
