from types import SimpleNamespace
from unittest.mock import Mock, patch

from app.models.subtask import SubtaskStatus
from app.services.chat.operations.retry import reset_subtask_for_retry


def test_retry_reset_preserves_executor_session_proof():
    session = {
        "agent": "ClaudeCode",
        "botId": 23,
        "sessionId": "session-1",
    }
    subtask = SimpleNamespace(
        id=42,
        message_id=77,
        result={"value": "failed answer", "executor_session": session},
    )

    with patch("app.services.chat.operations.retry.subtask_store") as store:
        reset_subtask_for_retry(Mock(), subtask)

    fields = store.update_fields.call_args.kwargs
    assert fields["status"] == SubtaskStatus.PENDING
    assert fields["result"] == {"executor_session": session}
