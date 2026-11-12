"""Archived private Runtime profiles cannot survive a cached execution read."""

import json
from datetime import datetime, timezone

import pytest
from sqlalchemy import select, update

from app.models.delivery import RuntimeProfile
from app.models.loop_item_execution import LoopItemExecution
from app.services.collaboration_revocation import execution_authorized
from tests.services.test_group_agent_resources import inline, project_agent
from tests.services.test_thread_participation import make_group, make_thread


@pytest.mark.parametrize("scope", ["group", "project"])
@pytest.mark.parametrize("revocation", ["archived", "deleted"])
def test_execution_rechecks_profile_behind_cached_identity(
    test_db, test_user, scope, revocation
):
    if scope == "group":
        container = make_group(test_db, test_user, [])
        agent = inline(test_db, test_user, container)
    else:
        container, agent = project_agent(test_db, test_user)
    item = make_thread(test_db, container, test_user)
    profile = RuntimeProfile(user_id=test_user.id, status="active")
    test_db.add(profile)
    test_db.flush()
    execution = LoopItemExecution(
        cloud_project_id=container.id,
        loop_item_id=item.id,
        agent_id=agent.id,
        assigner_user_id=test_user.id,
        executor_owner_user_id=test_user.id,
        execution_environment="local",
        execution_payload=json.dumps(
            {"runtime_selection": {"runtime_profile_id": profile.id}}
        ),
    )
    assert execution_authorized(test_db, execution) is True
    values = (
        {"status": "archived"}
        if revocation == "archived"
        else {"deleted_at": datetime.now(timezone.utc).replace(tzinfo=None)}
    )
    test_db.execute(
        update(RuntimeProfile)
        .where(RuntimeProfile.id == profile.id)
        .values(**values)
        .execution_options(synchronize_session=False)
    )
    if revocation == "archived":
        assert (
            test_db.scalar(
                select(RuntimeProfile.status).where(RuntimeProfile.id == profile.id)
            )
            == "archived"
        )
    assert profile.status == "active"
    assert execution_authorized(test_db, execution) is False
    assert execution.cloud_project_id == container.id
