# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from types import SimpleNamespace
from unittest.mock import Mock, patch

import pytest
from sqlalchemy.orm import Session

from app.models.task import TaskResource
from app.services.adapters.task_kinds.task_skills_resolver import resolve_task_skills


def _build_kind(user_id: int, payload: dict):
    return SimpleNamespace(user_id=user_id, json=payload, id=100, namespace="default")


@pytest.mark.unit
def test_resolve_task_skills_uses_batched_kind_loading_for_bots_and_ghosts():
    db = Mock(spec=Session)

    mock_task = Mock(spec=TaskResource)
    mock_task.id = 123
    mock_task.user_id = 7
    mock_task.kind = "Task"
    mock_task.is_active = TaskResource.STATE_ACTIVE
    mock_task.json = {"kind": "Task"}

    mock_task_query = Mock()
    mock_task_query.filter.return_value = mock_task_query
    mock_task_query.first.return_value = mock_task
    db.query.return_value = mock_task_query

    task_crd = SimpleNamespace(
        spec=SimpleNamespace(
            teamRef=SimpleNamespace(name="team-a", namespace="default"),
        ),
        metadata=SimpleNamespace(labels={}),
    )
    team_crd = SimpleNamespace(
        spec=SimpleNamespace(
            members=[
                SimpleNamespace(
                    botRef=SimpleNamespace(name="bot-a", namespace="default")
                ),
                SimpleNamespace(
                    botRef=SimpleNamespace(name="bot-b", namespace="default")
                ),
            ]
        )
    )

    bot_a = _build_kind(7, {"kind": "Bot", "name": "bot-a"})
    bot_b = _build_kind(7, {"kind": "Bot", "name": "bot-b"})
    ghost_a = _build_kind(7, {"kind": "Ghost", "name": "ghost-a"})
    ghost_b = _build_kind(7, {"kind": "Ghost", "name": "ghost-b"})

    bot_crd_a = SimpleNamespace(
        spec=SimpleNamespace(
            ghostRef=SimpleNamespace(name="ghost-a", namespace="default")
        )
    )
    bot_crd_b = SimpleNamespace(
        spec=SimpleNamespace(
            ghostRef=SimpleNamespace(name="ghost-b", namespace="default")
        )
    )
    ghost_crd_a = SimpleNamespace(
        spec=SimpleNamespace(skills=["alpha"], preload_skills=["pre-a"])
    )
    ghost_crd_b = SimpleNamespace(
        spec=SimpleNamespace(skills=["beta"], preload_skills=["pre-b"])
    )

    with (
        patch(
            "app.services.task_member_service.task_member_service.is_member",
            return_value=True,
        ),
        patch(
            "app.services.readers.kinds.kindReader.get_by_name_and_namespace",
            return_value=_build_kind(7, {"kind": "Team"}),
        ) as mock_kind_lookup,
        patch(
            "app.services.adapters.task_kinds.task_skills_resolver.Task.model_validate",
            return_value=task_crd,
        ),
        patch(
            "app.services.adapters.task_kinds.task_skills_resolver.Team.model_validate",
            return_value=team_crd,
        ),
        patch(
            "app.services.adapters.task_kinds.task_skills_resolver.Bot.model_validate",
            side_effect=[bot_crd_a, bot_crd_b],
        ),
        patch(
            "app.services.adapters.task_kinds.task_skills_resolver.Ghost.model_validate",
            side_effect=[ghost_crd_a, ghost_crd_b],
        ),
        patch(
            "app.services.adapters.task_kinds.task_skills_resolver._batch_load_kinds_by_refs",
            create=True,
            side_effect=[
                {
                    ("default", "bot-a"): bot_a,
                    ("default", "bot-b"): bot_b,
                },
                {
                    ("default", "ghost-a"): ghost_a,
                    ("default", "ghost-b"): ghost_b,
                },
            ],
        ) as mock_batch_loader,
    ):
        result = resolve_task_skills(db, task_id=123, user_id=99)

    assert set(result["skills"]) == {"alpha", "beta"}
    assert set(result["preload_skills"]) == {"pre-a", "pre-b"}
    assert mock_kind_lookup.call_count == 1
    assert mock_batch_loader.call_count == 2
