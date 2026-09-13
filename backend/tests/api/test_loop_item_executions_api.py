# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Focused API tests for LoopItem execution ownership."""

from contextlib import contextmanager
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.api.endpoints import loop_item_executions
from app.models.delivery import CloudProject, ProjectChatAgent
from app.models.loop_item_execution import LoopItemExecution
from app.models.user import User
from app.schemas.project_chat import LoopItemExecutionClaim


def test_runtime_write_back_authorizes_execution_owner(
    test_db: Session,
    test_user: User,
) -> None:
    agent_creator = User(
        user_name="agent-creator",
        password_hash="unused",
        email="agent-creator@example.com",
        is_active=True,
        git_info=None,
    )
    test_db.add(agent_creator)
    test_db.flush()
    execution = LoopItemExecution(
        loop_item_id="issue-write-back",
        cloud_project_id="73",
        executor_owner_user_id=test_user.id,
        agent_id="shared-agent",
        status="claimed",
    )
    test_db.add(execution)
    test_db.commit()
    test_db.refresh(execution)

    authorized = loop_item_executions._require_run_owner(
        test_db,
        project_id=73,
        execution_id=execution.id,
        user_id=test_user.id,
    )

    assert authorized.id == execution.id
    with pytest.raises(HTTPException) as error:
        loop_item_executions._require_run_owner(
            test_db,
            project_id=73,
            execution_id=execution.id,
            user_id=agent_creator.id,
        )
    assert error.value.status_code == 403


def test_agent_claim_uses_run_owner_not_agent_creator(
    monkeypatch,
    test_db: Session,
    test_user: User,
) -> None:
    run_owner = User(
        user_name="execution-owner",
        password_hash="unused",
        email="execution-owner@example.com",
        is_active=True,
        git_info=None,
    )
    project = CloudProject(
        public_id="execution-owner-project",
        project_key="RUNOWNER",
        name="Run owner project",
        description="",
        created_by_user_id=test_user.id,
        storage_prefix="projects/execution-owner-project",
        metadata_json={},
    )
    test_db.add_all([run_owner, project])
    test_db.flush()
    agent = ProjectChatAgent(
        id="agent-created-by-project-owner",
        cloud_project_id=project.id,
        title="Shared agent",
        name="Shared agent",
        status="active",
        created_by_user_id=test_user.id,
        metadata_json={},
    )
    test_db.add(agent)
    test_db.commit()
    test_db.refresh(run_owner)
    test_db.refresh(project)

    claimed = LoopItemExecution(
        id=41,
        loop_item_id="issue-1",
        cloud_project_id=str(project.id),
        executor_owner_user_id=run_owner.id,
        agent_id=agent.id,
        execution_environment="local",
        execution_device_id="owner-device",
        status="claimed",
    )
    claim = Mock(return_value=claimed)
    monkeypatch.setattr(
        loop_item_executions.loop_item_execution_service,
        "claim",
        claim,
    )
    monkeypatch.setattr(
        loop_item_executions,
        "get_runtime_capacity_sync",
        lambda *_args, **_kwargs: SimpleNamespace(
            runtime_instance_id="runtime-owner",
            limit=1,
            active=0,
            active_task_ids=set(),
        ),
    )

    @contextmanager
    def acquired(*_args, **_kwargs):
        yield True

    monkeypatch.setattr(
        loop_item_executions.distributed_lock,
        "acquire_context",
        acquired,
    )
    monkeypatch.setattr(
        loop_item_executions,
        "_claimed_execution_view",
        lambda _db, row: row,
    )

    result = loop_item_executions.claim_execution(
        project_id=project.id,
        values=LoopItemExecutionClaim(
            agent_id=agent.id,
            execution_device_id="owner-device",
            execution_environment="local",
        ),
        db=test_db,
        current_user=run_owner,
    )

    assert result is claimed
    claim.assert_called_once_with(
        test_db,
        agent_id=agent.id,
        execution_device_id="owner-device",
        environment="local",
        owner_user_id=run_owner.id,
        runtime_instance_id="runtime-owner",
        device_capacity=1,
        runtime_active=0,
        runtime_active_task_ids=set(),
        lease_seconds=300,
        assigner_filter=None,
    )
