# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for ending a version whose task died without the agent reporting.

The agent normally concludes its own run. What is pinned here is the case it cannot
cover — a container that disappears, an executor that dies — where the version would
otherwise stay RUNNING until the staleness sweep looks at it, which only happens when
the next run starts.
"""

from datetime import datetime
from unittest.mock import patch

import pytest

from app.core.events import TaskCompletedEvent
from app.models.wiki import WikiGeneration, WikiGenerationStatus
from app.services.knowledge.code_wiki import task_completion
from app.services.knowledge.code_wiki.task_completion import conclude_code_wiki_run


def _event(task_id: int, status: str = "FAILED", error: str = "container gone"):
    return TaskCompletedEvent(
        task_id=task_id, subtask_id=1, user_id=1, status=status, error=error
    )


@pytest.fixture
def session(test_db):
    """Point the handler's own session factory at the test database.

    It opens one of its own because it runs after the request that created the task
    has finished, so there is no request session to borrow.
    """
    with patch.object(task_completion, "SessionLocal", return_value=test_db):
        yield test_db


def _running(test_db, task_id: int) -> WikiGeneration:
    generation = WikiGeneration(
        project_id=1,
        kind_id=77,
        user_id=1,
        task_id=task_id,
        team_id=1,
        source_snapshot={},
        status=WikiGenerationStatus.RUNNING,
        ext={},
        completed_at=datetime(1970, 1, 1),
    )
    test_db.add(generation)
    test_db.flush()
    return generation


@pytest.mark.asyncio
async def test_a_task_that_dies_ends_the_version_it_was_writing(session):
    """Without this the wiki reports "generating" long after its executor has gone,
    and cannot be retriggered because the sweep has not run."""
    generation = _running(session, task_id=501)

    with patch.object(task_completion, "finish_run") as finish:
        await conclude_code_wiki_run(_event(501))

    finish.assert_called_once()
    assert finish.call_args.kwargs["succeeded"] is False
    assert finish.call_args.kwargs["generation"].id == generation.id


@pytest.mark.asyncio
async def test_the_failure_the_task_reported_is_carried_across(session):
    _running(session, task_id=502)

    with patch.object(task_completion, "finish_run") as finish:
        await conclude_code_wiki_run(_event(502, error="OOM killed"))

    assert "OOM killed" in finish.call_args.kwargs["error_message"]


@pytest.mark.asyncio
async def test_a_run_the_agent_already_concluded_is_left_alone(session):
    """Idempotent by construction: the query filters on RUNNING, so a version the
    agent finished is not found at all — no check that could race with it."""
    generation = _running(session, task_id=503)
    generation.status = WikiGenerationStatus.COMPLETED
    session.flush()

    with patch.object(task_completion, "finish_run") as finish:
        await conclude_code_wiki_run(_event(503, status="COMPLETED"))

    finish.assert_not_called()


@pytest.mark.asyncio
async def test_a_task_belonging_to_no_wiki_costs_one_indexed_lookup(session):
    """Almost no task is a code wiki's. This handler shares a loop with the
    subscription and IM ones, so it must return immediately for all of them.

    The count is asserted, not just the early return. `async def` does not make the
    session and query below yield -- they are synchronous, so the event loop is held
    for their duration and the publisher awaits every handler. What keeps that
    acceptable is that it is exactly one selective lookup, and that argument stops
    holding the moment a second query is added here.
    """
    from sqlalchemy import event as sa_event

    statements: list[str] = []

    def record(conn, cursor, statement, parameters, context, executemany):
        statements.append(statement)

    engine = session.get_bind()
    sa_event.listen(engine, "before_cursor_execute", record)
    try:
        with patch.object(task_completion, "finish_run") as finish:
            await conclude_code_wiki_run(_event(999999))
    finally:
        sa_event.remove(engine, "before_cursor_execute", record)

    finish.assert_not_called()
    selects = [s for s in statements if s.lstrip().upper().startswith("SELECT")]
    assert len(selects) == 1, selects
    assert "wiki_generations" in selects[0]


@pytest.mark.asyncio
async def test_a_failure_here_does_not_break_the_other_subscribers(session):
    """Handlers share a delivery. A code wiki has no claim to stop the IM channel
    handler from sending a task's result."""
    _running(session, task_id=504)

    with patch.object(
        task_completion, "finish_run", side_effect=RuntimeError("publish exploded")
    ):
        await conclude_code_wiki_run(_event(504))  # must not raise
