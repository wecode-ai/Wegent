# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

from types import SimpleNamespace
from typing import cast

from app.models.delivery import ProjectChatAgent
from app.services.collaboration_group_execution import resolve_collaboration_group_agent


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
