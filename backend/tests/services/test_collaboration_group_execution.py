# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

from types import SimpleNamespace
from typing import cast

import pytest
from fastapi import HTTPException

from app.models.delivery import LoopItem, ProjectChatAgent
from app.models.loop_item_execution import LoopItemExecution
from app.services.collaboration_group_execution import (
    collaboration_group_snapshot_for_dispatch,
    resolve_collaboration_group_agent,
)


def test_resolve_agent_accepts_the_bound_wegent_team_id() -> None:
    agent = cast(
        ProjectChatAgent,
        SimpleNamespace(
            id="project-agent-1",
            device_id="executor-1",
            metadata_json={
                "runtime": "wegent",
                "wegent_team_id": 42,
            },
        ),
    )

    assert resolve_collaboration_group_agent([agent], "42") is agent


def _item(assignment_key: str = "assignment-1") -> LoopItem:
    return cast(
        LoopItem,
        SimpleNamespace(
            metadata_json={
                "collaboration_group": {"id": "group-1"},
                "collaboration_group_assignment_key": assignment_key,
            }
        ),
    )


def _dispatch() -> LoopItemExecution:
    return cast(
        LoopItemExecution,
        SimpleNamespace(
            executor_type="collaboration_group_dispatch",
            runtime_origin_context={
                "dispatch_kind": "collaboration_group",
                "run_id": "collaboration-group:assignment-1",
                "collaboration_group_id": "group-1",
                "collaboration_group": {
                    "id": "group-1",
                    "leader": {"kind": "agent", "id": "manager-1"},
                    "members": [],
                },
            },
        ),
    )


def test_dispatch_snapshot_is_used_for_the_active_assignment() -> None:
    group = collaboration_group_snapshot_for_dispatch(
        item=_item(),
        execution=_dispatch(),
    )

    assert group["leader"]["id"] == "manager-1"


def test_stale_dispatch_cannot_control_a_reassigned_issue() -> None:
    with pytest.raises(HTTPException, match="no longer active") as error:
        collaboration_group_snapshot_for_dispatch(
            item=_item("assignment-2"),
            execution=_dispatch(),
        )

    assert error.value.status_code == 409
