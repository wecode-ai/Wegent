# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""MCP registration tool coverage for external event bindings."""

from __future__ import annotations

import uuid
from types import SimpleNamespace

import pytest
from sqlalchemy.orm import Session

from app.mcp_server.auth import MCPAuthInfo
from app.mcp_server.tools import wework_space
from app.models.delivery import CloudProject, LoopItem
from app.models.user import User
from app.services.external_events.buffer import external_event_buffer


class _SessionContext:
    def __init__(self, db: Session) -> None:
        self._db = db

    def __enter__(self) -> Session:
        return self._db

    def __exit__(self, *_args: object) -> None:
        return None


def _issue(db: Session, user: User) -> LoopItem:
    project = CloudProject(
        public_id=str(uuid.uuid4()),
        project_key="REG",
        name="Registration project",
        description="",
        created_by_user_id=user.id,
        storage_prefix=f"projects/{uuid.uuid4()}",
    )
    db.add(project)
    db.flush()
    item = LoopItem(
        id=f"{project.project_key}-1",
        cloud_project_id=str(project.id),
        sequence_number=1,
        title="Issue with preset workflow",
        description="",
        status="in_progress",
        priority="none",
        sort_order=0,
        created_by_user_id=user.id,
        metadata_json={
            "workflow": {
                "version": 1,
                "stage_mode": "dag",
                "advancement_policy": "manual",
                "nodes": [
                    {
                        "id": "stage-1",
                        "name": "Develop MR",
                        "node_type": "stage",
                        "depends_on": [],
                        "required": True,
                        "workspace_policy": "composer",
                        "status": "completed",
                    },
                    {
                        "id": "wait-1",
                        "name": "Wait external",
                        "node_type": "wait",
                        "depends_on": ["stage-1"],
                        "required": True,
                        "workspace_policy": "none",
                        "status": "waiting",
                        "wait_config": {
                            "rules": [
                                {
                                    "id": "rule-merged",
                                    "event_type": "merged",
                                    "action": "complete",
                                    "rerun_prompt": "",
                                }
                            ]
                        },
                    },
                ],
            }
        },
    )
    db.add(item)
    db.commit()
    db.refresh(project)
    db.refresh(item)
    return item


def _task_token(user: User) -> MCPAuthInfo:
    return MCPAuthInfo(
        user_id=user.id,
        user_name=user.user_name,
        auth_type="task",
        task_id=1,
        subtask_id=2,
    )


def _bind_task_labels(
    monkeypatch: pytest.MonkeyPatch,
    *,
    project_id: str,
    item_id: str,
    run_id: str,
) -> None:
    monkeypatch.setattr(
        wework_space.task_store,
        "get_by_id",
        lambda *_args, **_kwargs: SimpleNamespace(
            json={
                "metadata": {
                    "labels": {
                        "source": "project_automation",
                        "projectAutomationRunId": run_id,
                        "weworkSpaceProjectId": project_id,
                        "weworkSpaceTaskId": item_id,
                    }
                }
            }
        ),
    )


def test_register_external_reference_creates_binding_and_waits(
    test_db: Session,
    test_user: User,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    item = _issue(test_db, test_user)
    project_id = str(item.cloud_project_id)
    monkeypatch.setattr(wework_space, "SessionLocal", lambda: _SessionContext(test_db))
    _bind_task_labels(
        monkeypatch,
        project_id=project_id,
        item_id=item.id,
        run_id="run-1",
    )
    token = _task_token(test_user)
    external_event_buffer.take_for_reference("gitlab", "acme/app!7")

    result = wework_space.register_external_reference(
        token, provider="gitlab", opaque_ref="acme/app!7"
    )

    assert result["provider"] == "gitlab"
    assert result["opaque_ref"] == "acme/app!7"
    assert result["task_id"] == item.id
    assert result["issue_id"] == item.id
    assert result["workflow_node_id"] == "wait-1"
    assert result["compensated_event_count"] == 0
    assert result["binding_id"]

    from app.models.delivery import ExternalEventBinding

    binding = test_db.get(ExternalEventBinding, result["binding_id"])
    assert binding is not None
    assert binding.provider == "gitlab"
    assert binding.opaque_ref == "acme/app!7"
    assert binding.loop_item_id == item.id
    test_db.refresh(item)
    wait_node = next(
        node
        for node in item.metadata_json["workflow"]["nodes"]
        if node["id"] == "wait-1"
    )
    assert wait_node["status"] == "waiting"


def test_register_external_reference_requires_board_task(
    test_db: Session,
    test_user: User,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    item = _issue(test_db, test_user)
    monkeypatch.setattr(wework_space, "SessionLocal", lambda: _SessionContext(test_db))
    user_token = MCPAuthInfo(
        user_id=test_user.id,
        user_name=test_user.user_name,
        auth_type="user",
    )
    with pytest.raises(ValueError, match="board task"):
        wework_space.register_external_reference(
            user_token, provider="gitlab", opaque_ref="acme/app!7"
        )


def test_register_external_reference_rejects_issue_without_wait_node(
    test_db: Session,
    test_user: User,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    item = _issue(test_db, test_user)
    project_id = str(item.cloud_project_id)
    metadata = dict(item.metadata_json or {})
    workflow = dict(metadata["workflow"])
    workflow["nodes"] = [node for node in workflow["nodes"] if node["id"] != "wait-1"]
    metadata["workflow"] = workflow
    item.metadata_json = metadata
    test_db.commit()
    monkeypatch.setattr(wework_space, "SessionLocal", lambda: _SessionContext(test_db))
    _bind_task_labels(
        monkeypatch,
        project_id=project_id,
        item_id=item.id,
        run_id="run-1",
    )

    with pytest.raises(ValueError, match="wait node"):
        wework_space.register_external_reference(
            _task_token(test_user), provider="gitlab", opaque_ref="acme/app!7"
        )
