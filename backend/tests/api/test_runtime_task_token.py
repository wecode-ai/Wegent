"""Task identity stays stable across issuance, while users/devices remain isolated."""

import jwt
import pytest
from pydantic import ValidationError

from app.core.config import settings
from app.services.auth.runtime_task_token import issue_runtime_task_token
from app.services.auth.task_token import verify_task_token


def test_runtime_task_identity_roundtrip(test_db, test_user, test_client):
    def identity(device, task):
        issued = issue_runtime_task_token(
            test_db, user_id=test_user.id, device_id=device, data={"task_id": task}
        )
        info = verify_task_token(issued["auth_token"])
        assert info.runtime_task.task_id == task
        response = test_client.get(
            "/api/external/mcp-identity/userinfo",
            headers={"Authorization": f"Bearer {issued['auth_token']}"},
        )
        assert response.status_code == 200
        return response.json()

    first = identity("device-a", "task-a")
    assert first == identity("device-a", "task-a")
    assert first["id"] == test_user.id
    assert first["task"] == {"kind": "runtime", "id": "task-a", "device_id": "device-a"}
    assert first["task"] != identity("device-a", "task-b")["task"]
    assert first["task"] != identity("device-b", "task-a")["task"]


@pytest.mark.parametrize(
    "data",
    [
        {"task_id": ""},
        {"task_id": "  "},
        {"task_id": 7},
        {"task_id": "a", "user_id": 999},
        {"task_id": "a", "device_id": "other"},
    ],
)
def test_native_request_cannot_override_identity(test_db, test_user, data):
    with pytest.raises(ValidationError):
        issue_runtime_task_token(
            test_db, user_id=test_user.id, device_id="device", data=data
        )


@pytest.mark.parametrize(
    "runtime_task",
    [
        None,
        {"device_id": "a"},
        {"device_id": "a", "task_id": 42},
        {"device_id": "a", "task_id": "b", "user_id": 999},
    ],
)
def test_invalid_signed_runtime_identity_is_rejected(runtime_task):
    token = jwt.encode(
        {
            "type": "task_token",
            "task_id": 0,
            "subtask_id": 0,
            "user_id": 1,
            "user_name": "test",
            "runtime_task": runtime_task,
        },
        settings.SECRET_KEY,
        algorithm=settings.ALGORITHM,
    )
    assert verify_task_token(token) is None


def test_task_token_native_event_excluded_from_payload_tracing():
    from app.api.ws.device_namespace import (
        DEVICE_TRACE_EXCLUDED_EVENTS,
        DeviceNamespace,
    )

    assert "plugin.task_token.issue" in DEVICE_TRACE_EXCLUDED_EVENTS
    assert (
        DeviceNamespace()._event_handlers["plugin.task_token.issue"]
        == "on_plugin_task_token_issue"
    )
