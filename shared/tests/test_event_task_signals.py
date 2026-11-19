from types import SimpleNamespace

import pytest

from shared.event_reporting import celery as reporting


@pytest.mark.parametrize("state", ["SUCCESS", "FAILURE", "RETRY", "REVOKED"])
def test_task_outcome_is_raw_not_inferred_success(mocker, state):
    facts = []
    mocker.patch.object(
        reporting,
        "observe",
        side_effect=lambda name, factory: facts.append((name, factory())),
    )
    task = SimpleNamespace(
        name="app.tasks.knowledge_tasks.index_document",
        request=SimpleNamespace(retries=2),
    )
    reporting.task_finished(
        task=task,
        task_id="t1",
        args=["7", 2, "", "", "", "", 3, "", 9, 4],
        state=state,
        retval={"status": "skipped", "reason": "stale"},
    )
    frame = facts[0][1]
    assert frame["document_id"] == 9
    assert frame["data"]["generation"] == 4
    assert frame["data"]["task_state"] == state
    assert frame["data"]["result_status"] == "skipped"
    assert frame["status"] == "completed"


def test_unrelated_task_has_no_fact(mocker):
    emit = mocker.patch.object(reporting, "observe")
    reporting.task_started(task=SimpleNamespace(name="other"))
    emit.assert_not_called()
