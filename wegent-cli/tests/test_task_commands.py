import json
from unittest.mock import MagicMock, patch

from click.testing import CliRunner
from wegent.cli import cli
from wegent.errors import EXIT_API_ERROR, CliError


def invoke_with_client(args, client, input_text=None):
    with patch("wegent.cli.WegentClient", return_value=client):
        return CliRunner().invoke(cli, args, input=input_text)


def load_payload(result):
    return json.loads(result.stderr or result.output)


def test_task_create_reads_stdin_payload():
    client = MagicMock()
    client.create_task.return_value = {"id": 123, "status": "pending"}

    result = invoke_with_client(
        ["task", "create", "--input", "-", "--json"],
        client,
        input_text='{"teamRef": "default#agent", "prompt": "hello"}',
    )

    assert result.exit_code == 0
    assert json.loads(result.output) == {
        "success": True,
        "data": {"id": 123, "status": "pending"},
    }
    client.create_task.assert_called_once_with(
        {"teamRef": "default#agent", "prompt": "hello"}
    )


def test_task_status_uses_task_detail_by_default():
    client = MagicMock()
    client.get_task.return_value = {"id": 123, "status": "running"}

    result = invoke_with_client(["task", "status", "123", "--json"], client)

    assert result.exit_code == 0
    assert json.loads(result.output)["data"] == {"id": 123, "status": "running"}
    client.get_task.assert_called_once_with(123)
    client.get_task_runtime.assert_not_called()


def test_task_status_runtime_uses_runtime_endpoint():
    client = MagicMock()
    client.get_task_runtime.return_value = {"task_id": 123, "runtime_status": "alive"}

    result = invoke_with_client(
        ["task", "status", "123", "--runtime", "--json"],
        client,
    )

    assert result.exit_code == 0
    assert json.loads(result.output)["data"]["runtime_status"] == "alive"
    client.get_task.assert_not_called()
    client.get_task_runtime.assert_called_once_with(123)


def test_task_result_extracts_assistant_outputs():
    client = MagicMock()
    task = {
        "id": 123,
        "status": "success",
        "subtasks": [
            {"role": "user", "result": {"content": "ignore me"}},
            {"role": "assistant", "result": {"content": ""}, "content": "top"},
            {"role": "assistant", "result": {"response": "nested response"}},
            {"role": "assistant", "result": {"output": "nested output"}},
        ],
    }
    client.get_task.return_value = task

    result = invoke_with_client(["task", "result", "123", "--json"], client)

    assert result.exit_code == 0
    payload = json.loads(result.output)
    assert payload == {
        "success": True,
        "data": {
            "task_id": 123,
            "status": "success",
            "messages": ["top", "nested response", "nested output"],
            "task": task,
        },
    }
    client.get_task.assert_called_once_with(123)


def test_task_result_extracts_backend_assistant_value():
    client = MagicMock()
    task = {
        "id": 123,
        "status": "COMPLETED",
        "subtasks": [
            {"role": "USER", "result": {"value": "ignore me"}},
            {"role": "ASSISTANT", "result": {"value": "final answer"}},
        ],
    }
    client.get_task.return_value = task

    result = invoke_with_client(["task", "result", "123", "--json"], client)

    assert result.exit_code == 0
    payload = json.loads(result.output)
    assert payload["data"]["status"] == "COMPLETED"
    assert payload["data"]["messages"] == ["final answer"]


def test_task_cancel_uses_cancel_endpoint():
    client = MagicMock()
    client.cancel_task.return_value = {"id": 123, "status": "cancelled"}

    result = invoke_with_client(["task", "cancel", "123", "--json"], client)

    assert result.exit_code == 0
    assert json.loads(result.output)["data"]["status"] == "cancelled"
    client.cancel_task.assert_called_once_with(123)


def test_task_create_rejects_non_object_input_without_client_call():
    client = MagicMock()

    result = invoke_with_client(
        ["task", "create", "--input", "-", "--json"],
        client,
        input_text='["not", "an", "object"]',
    )

    assert result.exit_code != 0
    payload = load_payload(result)
    assert payload["success"] is False
    assert payload["error"]["code"] == "invalid_input"
    assert payload["error"]["message"] == "Task create input must be a JSON object"
    client.create_task.assert_not_called()


def test_task_subcommand_json_renders_client_error_envelope():
    client = MagicMock()
    client.get_task.side_effect = CliError(
        "api_error",
        "backend failed",
        {"status_code": 500},
        EXIT_API_ERROR,
    )

    result = invoke_with_client(["task", "status", "123", "--json"], client)

    assert result.exit_code == EXIT_API_ERROR
    payload = load_payload(result)
    assert payload["success"] is False
    assert payload["error"]["code"] == "api_error"
    assert payload["error"]["message"] == "backend failed"


def test_task_subcommand_non_json_renders_plain_error():
    client = MagicMock()
    client.get_task.side_effect = CliError(
        "api_error",
        "backend failed",
        {"status_code": 500},
        EXIT_API_ERROR,
    )

    result = invoke_with_client(["task", "status", "123"], client)

    assert result.exit_code == EXIT_API_ERROR
    assert result.stderr == "Error: backend failed\n"
    assert not result.stderr.lstrip().startswith("{")


def test_task_result_extracts_top_level_assistant_content_fallback():
    client = MagicMock()
    client.get_task.return_value = {
        "id": 123,
        "status": "success",
        "subtasks": [
            {"role": "assistant", "result": {"content": ""}, "text": "top text"},
        ],
    }

    result = invoke_with_client(["task", "result", "123", "--json"], client)

    assert result.exit_code == 0
    assert json.loads(result.output)["data"]["messages"] == ["top text"]


def test_task_result_extracts_string_result():
    client = MagicMock()
    client.get_task.return_value = {
        "id": 123,
        "status": "success",
        "subtasks": [
            {"role": "ASSISTANT", "result": "direct answer"},
        ],
    }

    result = invoke_with_client(["task", "result", "123", "--json"], client)

    assert result.exit_code == 0
    assert json.loads(result.output)["data"]["messages"] == ["direct answer"]
