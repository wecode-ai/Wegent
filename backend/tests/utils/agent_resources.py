# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Factories for complete Agent resource graphs used by service tests."""

from __future__ import annotations

import uuid

from sqlalchemy.orm import Session

from app.models.kind import Kind


def create_runnable_wegent_team(
    db: Session,
    *,
    user_id: int,
    name_prefix: str,
) -> Kind:
    suffix = uuid.uuid4().hex[:8]
    model_name = f"{name_prefix}-model-{suffix}"
    shell_name = f"{name_prefix}-shell-{suffix}"
    ghost_name = f"{name_prefix}-ghost-{suffix}"
    bot_name = f"{name_prefix}-bot-{suffix}"
    team_name = f"{name_prefix}-team-{suffix}"

    def resource(kind: str, name: str, spec: dict) -> Kind:
        return Kind(
            kind=kind,
            name=name,
            namespace="default",
            user_id=user_id,
            is_active=True,
            json={
                "apiVersion": "agent.wecode.io/v1",
                "kind": kind,
                "metadata": {"name": name, "namespace": "default"},
                "spec": spec,
            },
        )

    model = resource(
        "Model",
        model_name,
        {
            "modelConfig": {
                "env": {
                    "api_key": "test-key",
                    "base_url": "https://models.invalid/v1",
                    "model_id": "test-model",
                    "model": "openai",
                }
            },
            "protocol": "openai",
        },
    )
    shell = resource("Shell", shell_name, {"shellType": "Chat"})
    ghost = resource(
        "Ghost", ghost_name, {"systemPrompt": "Handle the assigned Issue."}
    )
    bot = resource(
        "Bot",
        bot_name,
        {
            "ghostRef": {"name": ghost_name, "namespace": "default"},
            "shellRef": {"name": shell_name, "namespace": "default"},
            "modelRef": {"name": model_name, "namespace": "default"},
        },
    )
    team = resource(
        "Team",
        team_name,
        {
            "members": [
                {"botRef": {"name": bot_name, "namespace": "default"}},
            ],
            "collaborationModel": "solo",
        },
    )
    db.add_all([model, shell, ghost, bot, team])
    db.commit()
    db.refresh(team)
    return team
