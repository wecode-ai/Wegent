# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Arrange and inspect a real collaboration round for stage-assignee E2E."""

import argparse
import json
import os
from uuid import uuid4

from sqlalchemy import or_
from sqlalchemy.orm import Session

from app.db.session import SessionLocal
from app.models.delivery import (
    CloudProject,
    LoopItem,
    LoopItemComment,
    ProjectChatAgent,
)
from app.models.loop_item_execution import LoopItemExecution
from app.models.project_chat_message import ProjectChatMessage
from app.models.wework_notification import WeworkNotification


def seed_dispatch(
    db: Session,
    *,
    issue_id: str,
    target_user_id: int,
) -> dict[str, str]:
    item = db.get(LoopItem, issue_id)
    if item is None:
        raise ValueError("E2E Issue does not exist")
    project = db.get(CloudProject, item.cloud_project_id)
    if project is None:
        raise ValueError("E2E project does not exist")

    manager_id = f"stage-manager-{uuid4().hex[:16]}"
    group_id = f"stage-group-{uuid4().hex[:16]}"
    dispatch_id = f"stage-dispatch-{uuid4().hex[:16]}"
    assignment_key = uuid4().hex
    group = {
        "id": group_id,
        "name": "Stage permission E2E",
        "leader": {"kind": "agent", "id": manager_id},
        "members": [
            {"kind": "agent", "id": manager_id},
            {"kind": "human", "id": str(target_user_id)},
        ],
    }
    manager = ProjectChatAgent(
        id=manager_id,
        cloud_project_id=project.id,
        title="Stage manager",
        name="Stage manager",
        status="active",
        created_by_user_id=project.created_by_user_id,
        metadata_json={"wegent_team_id": manager_id},
    )
    runtime_task_id = f"stage-runtime-{uuid4().hex[:16]}"
    execution = LoopItemExecution(
        loop_item_id=item.id,
        cloud_project_id=str(project.id),
        agent_id="",
        executor_owner_user_id=project.created_by_user_id,
        assigner_user_id=project.created_by_user_id,
        runtime_device_id="stage-e2e-device",
        runtime_instance_id="stage-e2e-instance",
        runtime_task_id=runtime_task_id,
        execution_environment="cloud",
        execution_payload=json.dumps(
            {
                "runtime_selection": {
                    "executor_kind": "collaboration_group_dispatch",
                },
                "origin_context": {
                    "dispatch_kind": "collaboration_group",
                    "dispatch_role": "manager",
                    "manager_agent_id": manager_id,
                    "dispatch_id": dispatch_id,
                    "run_id": f"collaboration-group:{assignment_key}",
                    "collaboration_group_id": group_id,
                    "assignment_key": assignment_key,
                    "collaboration_group": group,
                },
            }
        ),
        status="running",
    )
    metadata = dict(item.metadata_json or {})
    metadata["collaboration_group"] = {
        "id": group_id,
        "name": "Stage permission E2E",
    }
    metadata["collaboration_group_assignment_key"] = assignment_key
    item.metadata_json = metadata
    db.add_all([manager, execution])
    db.commit()
    return {
        "dispatch_id": dispatch_id,
        "manager_agent_id": manager_id,
        "manager_runtime_task_id": f"{runtime_task_id}-manager-initial",
    }


def snapshot_issue(db: Session, issue_id: str) -> dict[str, object]:
    item = db.get(LoopItem, issue_id)
    if item is None:
        raise ValueError("E2E Issue does not exist")
    return {
        "version": item.version,
        "assignee_user_id": item.assignee_user_id,
        "assignment_history_length": len(
            (item.metadata_json or {}).get("assignment_history") or []
        ),
        "executions": db.query(LoopItemExecution)
        .filter(LoopItemExecution.loop_item_id == issue_id)
        .count(),
        "messages": db.query(ProjectChatMessage)
        .filter(ProjectChatMessage.task_id == issue_id)
        .count(),
        "notifications": db.query(WeworkNotification)
        .filter(
            or_(
                WeworkNotification.payload["itemId"].as_string() == issue_id,
                WeworkNotification.payload["issueId"].as_string() == issue_id,
            )
        )
        .count(),
        "comments": db.query(LoopItemComment)
        .filter(LoopItemComment.loop_item_id == issue_id)
        .count(),
    }


def cleanup_dispatch(db: Session, *, issue_id: str, manager_id: str) -> None:
    for execution in (
        db.query(LoopItemExecution)
        .filter(LoopItemExecution.loop_item_id == issue_id)
        .all()
    ):
        if (execution.runtime_origin_context or {}).get(
            "manager_agent_id"
        ) == manager_id:
            db.delete(execution)
    manager = db.get(ProjectChatAgent, manager_id)
    if manager is not None:
        db.delete(manager)
    db.commit()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="action", required=True)
    seed = commands.add_parser("seed")
    seed.add_argument("issue_id")
    seed.add_argument("target_user_id", type=int)
    snapshot = commands.add_parser("snapshot")
    snapshot.add_argument("issue_id")
    cleanup = commands.add_parser("cleanup")
    cleanup.add_argument("issue_id")
    cleanup.add_argument("manager_id")
    args = parser.parse_args()
    if not os.environ.get("DATABASE_URL"):
        parser.error("DATABASE_URL must explicitly select the running E2E database")
    with SessionLocal() as db:
        if args.action == "seed":
            print(
                json.dumps(
                    seed_dispatch(
                        db,
                        issue_id=args.issue_id,
                        target_user_id=args.target_user_id,
                    )
                )
            )
        elif args.action == "snapshot":
            print(json.dumps(snapshot_issue(db, args.issue_id)))
        else:
            cleanup_dispatch(
                db,
                issue_id=args.issue_id,
                manager_id=args.manager_id,
            )


if __name__ == "__main__":
    main()
