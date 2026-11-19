"""CP10/CP15: shared results never authorize a personal assistant's private process."""

import json

import pytest
from fastapi import HTTPException

from app.schemas.runtime_work import RuntimeTranscriptRequest
from app.services.project_chat.session_access import resolve_project_transcript
from tests.services.test_project_comment_execution import scenario


@pytest.mark.parametrize("status", ["claimed", "running", "completed", "cancelled"])
def test_cp10_cp15_assistant_transcript_remains_owner_only(scenario, status):
    s = scenario
    s.execution.execution_payload = json.dumps(
        {"runtime_selection": {"executor_kind": "human_assistant"}}
    )
    s.execution.status = status
    s.db.commit()
    request = RuntimeTranscriptRequest(
        deviceId=s.execution.runtime_device_id,
        taskId=s.execution.runtime_task_id,
        projectSession={"projectId": str(s.project.id), "issueId": s.issue.id},
    )

    with pytest.raises(HTTPException) as denied:
        resolve_project_transcript(s.db, s.member.id, request)

    assert denied.value.status_code == 404
    owner, address = resolve_project_transcript(s.db, s.owner.id, request)
    assert owner == s.owner.id
    assert address.local_task_id == s.execution.runtime_task_id
