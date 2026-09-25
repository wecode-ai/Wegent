# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Enqueue one collaboration-group dispatch for an Executor.

The backend persists the Issue assignment and supplies the immutable group
snapshot needed to route the first dispatch. The Executor owns manager runs,
member runs, round barriers, and every continuation after this handoff.
"""

from __future__ import annotations

import json
from dataclasses import replace
from typing import Any
from uuid import uuid4

from fastapi import HTTPException
from fastapi.encoders import jsonable_encoder
from sqlalchemy.orm import Session

from app.models.delivery import CloudProject, LoopItem, ProjectChatAgent
from app.models.loop_item_execution import LoopItemExecution
from app.services.loop_item_executions.profile import (
    WeworkExecutionProfile,
    native_runtime_contract,
)
from app.services.loop_item_executions.service import loop_item_execution_service
from app.services.project_chat.service import bot_config, compiled_bot_config
from app.services.workspaces import workspace_service

MANAGER_SYSTEM_INSTRUCTIONS = """You are the manager for one project Issue.
Coordinate the collaboration group through the project-space management tools.
Assign one concurrent batch of concrete tasks at a time. Each task must identify
its assignee and, when configured, its workflow stage. Do not execute member work
yourself. After every batch finishes, evaluate the evidence and either assign the
next batch or explicitly update the Issue status."""


def ensure_collaboration_group_execution(
    db: Session,
    *,
    item: LoopItem,
    user_id: int,
    group: dict[str, Any],
) -> LoopItemExecution:
    """Create exactly one Executor handoff for this group assignment."""

    metadata = dict(item.metadata_json or {})
    assignment_key = str(metadata.get("collaboration_group_assignment_key") or "")
    if not assignment_key:
        raise RuntimeError("Collaboration group assignment key is unavailable")
    run_id = f"collaboration-group:{assignment_key}"
    existing = (
        db.query(LoopItemExecution)
        .filter(
            LoopItemExecution.loop_item_id == item.id,
            LoopItemExecution.automation_run_id == run_id,
        )
        .order_by(LoopItemExecution.id.desc())
        .first()
    )
    if existing is not None:
        return existing

    project = db.get(CloudProject, item.cloud_project_id)
    if project is None:
        raise RuntimeError("Collaboration group project is unavailable")
    leader = _manager_agent(
        db,
        project=project,
        group=group,
    )
    config = compiled_bot_config(
        db,
        leader,
        execution_user_id=int(leader.created_by_user_id or user_id),
    )
    try:
        native_runtime_contract(str(config.get("runtime") or "codex"))
    except ValueError as exc:
        raise HTTPException(
            422,
            "Collaboration group AI must use an Executor runtime",
        ) from exc
    manager_user_message = _manager_user_message(
        project=project,
        item=item,
        group=group,
    )
    context = {
        "run_id": run_id,
        "dispatch_kind": "collaboration_group",
        "dispatch_id": f"collaboration-group:{group['id']}:{assignment_key}",
        "dispatch_task_id": item.id,
        "dispatch_role": "manager",
        "manager_agent_id": leader.id,
        "collaboration_group_id": str(group["id"]),
        "manager_display_name": str(group.get("name") or "Collaboration manager"),
        "collaboration_group": jsonable_encoder(group),
        "execution_prompt": manager_user_message,
        "system_prompt": MANAGER_SYSTEM_INSTRUCTIONS,
    }
    device_id = str(config.get("execution_device_id") or "") or None
    dispatch = loop_item_execution_service.enqueue_collaboration_group_dispatch(
        db,
        loop_item_id=item.id,
        cloud_project_id=str(project.id),
        owner_user_id=int(leader.created_by_user_id or user_id),
        assigner_user_id=user_id,
        environment=str(config.get("execution_environment") or "local"),
        execution_device_id=device_id,
        priority=item.priority,
        dispatch_context=context,
    )
    profile = replace(
        WeworkExecutionProfile.for_project_robot(
            leader,
            db=db,
            cloud_project_id=str(project.id),
        ),
        execution_prompt=manager_user_message,
    )
    request = profile.build_runtime_request(
        db,
        execution_id=dispatch.id,
        runtime_task_id=dispatch.runtime_task_id,
        task=item,
        cloud_project_id=str(project.id),
        origin_context=context,
        execution_device_id=device_id or "",
    )
    dispatch.execution_payload = json.dumps(
        {
            "runtime_selection": dict(dispatch.runtime_selection),
            "origin_context": context,
            "dispatch_request": {
                "kind": "collaboration_group",
                "manager_runtime_request": request.model_dump(
                    by_alias=True,
                    exclude_none=True,
                ),
            },
        },
        ensure_ascii=False,
        separators=(",", ":"),
    )
    db.flush()
    return dispatch


def collaboration_group_for_item(
    db: Session,
    *,
    item: LoopItem,
    user_id: int,
) -> dict[str, Any] | None:
    metadata = item.metadata_json if isinstance(item.metadata_json, dict) else {}
    reference = metadata.get("collaboration_group")
    group_id = str(reference.get("id") or "") if isinstance(reference, dict) else ""
    if not group_id:
        return None
    return next(
        (
            dict(group)
            for group in workspace_service.list_project_collaboration_groups(
                db, int(item.cloud_project_id), user_id
            )
            if str(group.get("id") or "") == group_id
        ),
        None,
    )


def collaboration_group_agent_matches(
    member: object,
    agent: ProjectChatAgent,
) -> bool:
    """Match a group agent reference to its project agent record."""

    if not isinstance(member, dict) or member.get("kind") != "agent":
        return False
    member_id = str(member.get("id") or "")
    if not member_id:
        return False
    metadata = agent.metadata_json if isinstance(agent.metadata_json, dict) else {}
    team_id = metadata.get("wegent_team_id")
    return member_id == str(agent.id) or (
        team_id is not None and member_id == str(team_id)
    )


def new_assignment_key() -> str:
    return uuid4().hex


def _manager_agent(
    db: Session,
    *,
    project: CloudProject,
    group: dict[str, Any],
) -> ProjectChatAgent:
    leader = group.get("leader")
    if not isinstance(leader, dict) or leader.get("kind") != "agent":
        raise HTTPException(422, "Collaboration group manager must be an AI member")
    leader_id = str(leader.get("id") or "")
    agents = _project_agents(db, project_id=str(project.id))
    resolved = _resolve_agent(agents, leader_id)
    if not leader_id or resolved is None:
        raise HTTPException(422, "Collaboration group has no AI manager")
    return resolved


def _project_agents(db: Session, *, project_id: str) -> list[ProjectChatAgent]:
    return (
        db.query(ProjectChatAgent)
        .filter(
            ProjectChatAgent.cloud_project_id == project_id,
            ProjectChatAgent.status == "active",
        )
        .all()
    )


def _resolve_agent(
    agents: list[ProjectChatAgent], member_id: str
) -> ProjectChatAgent | None:
    return next(
        (
            agent
            for agent in agents
            if str(agent.id) == member_id
            or (
                member_id.isdigit()
                and bot_config(agent).get("wegent_team_id") == int(member_id)
            )
        ),
        None,
    )


def _manager_user_message(
    *,
    project: CloudProject,
    item: LoopItem,
    group: dict[str, Any],
) -> str:
    project_metadata = (
        project.metadata_json if isinstance(project.metadata_json, dict) else {}
    )
    workflow = project_metadata.get("workflow_definition")
    stages = group.get("stages")
    members = group.get("members")
    rules = {
        "group": {
            "id": str(group.get("id") or ""),
            "name": str(group.get("name") or ""),
            "description": str(group.get("description") or ""),
            "coordination_mode": str(group.get("coordination_mode") or ""),
        },
        "group_instructions": str(group.get("instructions") or ""),
        "leader": _member_rule(group.get("leader")),
        "members": [
            normalized
            for member in (members if isinstance(members, list) else [])
            if (normalized := _member_rule(member)) is not None
        ],
        "group_stages": stages if isinstance(stages, list) else [],
        "project_workflow": workflow if isinstance(workflow, dict) else {},
    }
    return "\n\n".join(
        [
            f"Issue: {item.title}",
            f"Issue description:\n{item.description or ''}",
            "Project collaboration rules and workflow:\n"
            + json.dumps(rules, ensure_ascii=False, indent=2),
            (
                "Coordinate this Issue with the configured collaboration group. "
                "Use the Issue status tool only after you have evaluated the "
                "member results."
            ),
        ]
    )


def _member_rule(value: object) -> dict[str, str] | None:
    if not isinstance(value, dict):
        return None
    member_id = str(value.get("id") or "")
    kind = str(value.get("kind") or "")
    if not member_id or kind not in {"agent", "human"}:
        return None
    return {
        "kind": kind,
        "id": member_id,
        "name": str(value.get("name") or value.get("title") or ""),
        "responsibility": str(value.get("responsibility") or ""),
    }
