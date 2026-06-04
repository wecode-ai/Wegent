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


def assistant_response(text="Hello from Wegent"):
    return {
        "id": "resp_1",
        "output": [
            {
                "type": "message",
                "role": "assistant",
                "content": [{"type": "output_text", "text": text}],
            }
        ],
    }


def test_response_create_reads_stdin_payload_and_sets_model():
    client = MagicMock()
    client.create_response.return_value = {"id": "resp_1"}

    result = invoke_with_client(
        [
            "response",
            "create",
            "--input",
            "-",
            "--model",
            "default#wegent-chat",
            "--json",
        ],
        client,
        input_text='{"input": "hello", "temperature": 0}',
    )

    assert result.exit_code == 0
    assert json.loads(result.output) == {
        "success": True,
        "data": {"id": "resp_1"},
    }
    client.create_response.assert_called_once_with(
        {"input": "hello", "temperature": 0, "model": "default#wegent-chat"}
    )


def test_response_create_does_not_mutate_loaded_payload_when_overriding_model():
    client = MagicMock()
    client.create_response.return_value = {"id": "resp_1"}
    loaded_payload = {"input": "hello", "model": "default#original"}

    with patch(
        "wegent.commands.response.load_structured_input",
        return_value=loaded_payload,
    ):
        result = invoke_with_client(
            [
                "response",
                "create",
                "--input",
                "payload.json",
                "--model",
                "default#override",
                "--json",
            ],
            client,
        )

    assert result.exit_code == 0
    assert loaded_payload == {"input": "hello", "model": "default#original"}
    client.create_response.assert_called_once_with(
        {"input": "hello", "model": "default#override"}
    )


def test_response_create_json_missing_model_returns_error_without_client_call():
    client = MagicMock()

    result = invoke_with_client(
        ["response", "create", "--input", "-", "--json"],
        client,
        input_text='{"input": "hello"}',
    )

    assert result.exit_code != 0
    payload = load_payload(result)
    assert payload["success"] is False
    assert payload["error"]["code"] == "missing_model"
    client.create_response.assert_not_called()


def test_response_create_rejects_streaming_payload_before_client_call():
    client = MagicMock()

    result = invoke_with_client(
        ["response", "create", "--input", "-", "--json"],
        client,
        input_text='{"model": "default#wegent-chat", "input": "hello", "stream": true}',
    )

    assert result.exit_code != 0
    payload = load_payload(result)
    assert payload["success"] is False
    assert payload["error"]["code"] == "unsupported_streaming"
    client.create_response.assert_not_called()


def test_response_create_rejects_string_truthy_streaming_payload():
    client = MagicMock()

    result = invoke_with_client(
        ["response", "create", "--input", "-", "--json"],
        client,
        input_text='{"model": "default#wegent-chat", "input": "hello", "stream": "true"}',
    )

    assert result.exit_code != 0
    payload = load_payload(result)
    assert payload["success"] is False
    assert payload["error"]["code"] == "unsupported_streaming"
    client.create_response.assert_not_called()


def test_response_create_rejects_yaml_truthy_streaming_payload():
    client = MagicMock()

    result = invoke_with_client(
        ["response", "create", "--input", "-", "--json"],
        client,
        input_text=("model: default#wegent-chat\n" "input: hello\n" "stream: yes\n"),
    )

    assert result.exit_code != 0
    payload = load_payload(result)
    assert payload["success"] is False
    assert payload["error"]["code"] == "unsupported_streaming"
    client.create_response.assert_not_called()


def test_response_create_rejects_numeric_truthy_streaming_payload():
    client = MagicMock()

    result = invoke_with_client(
        ["response", "create", "--input", "-", "--json"],
        client,
        input_text='{"model": "default#wegent-chat", "input": "hello", "stream": 1}',
    )

    assert result.exit_code != 0
    payload = load_payload(result)
    assert payload["success"] is False
    assert payload["error"]["code"] == "unsupported_streaming"
    client.create_response.assert_not_called()


def test_response_create_rejects_float_truthy_streaming_payload():
    client = MagicMock()

    result = invoke_with_client(
        ["response", "create", "--input", "-", "--json"],
        client,
        input_text='{"model": "default#wegent-chat", "input": "hello", "stream": 1.0}',
    )

    assert result.exit_code != 0
    payload = load_payload(result)
    assert payload["success"] is False
    assert payload["error"]["code"] == "unsupported_streaming"
    client.create_response.assert_not_called()


def test_response_create_allows_explicit_non_streaming_payload():
    client = MagicMock()
    client.create_response.return_value = {"id": "resp_1"}

    result = invoke_with_client(
        ["response", "create", "--input", "-", "--json"],
        client,
        input_text='{"model": "default#wegent-chat", "input": "hello", "stream": false}',
    )

    assert result.exit_code == 0
    client.create_response.assert_called_once_with(
        {"model": "default#wegent-chat", "input": "hello", "stream": False}
    )


def test_response_get_cancel_delete_use_expected_client_methods():
    client = MagicMock()
    client.get_response.return_value = {"id": "resp_123", "status": "completed"}
    client.cancel_response.return_value = {"id": "resp_123", "status": "cancelled"}
    client.delete_response.return_value = {"id": "resp_123", "deleted": True}

    get_result = invoke_with_client(["response", "get", "resp_123", "--json"], client)
    cancel_result = invoke_with_client(
        ["response", "cancel", "resp_123", "--json"], client
    )
    delete_result = invoke_with_client(
        ["response", "delete", "resp_123", "--json"], client
    )

    assert get_result.exit_code == 0
    assert cancel_result.exit_code == 0
    assert delete_result.exit_code == 0
    assert json.loads(get_result.output)["data"]["status"] == "completed"
    assert json.loads(cancel_result.output)["data"]["status"] == "cancelled"
    assert json.loads(delete_result.output)["data"]["deleted"] is True
    client.get_response.assert_called_once_with("resp_123")
    client.cancel_response.assert_called_once_with("resp_123")
    client.delete_response.assert_called_once_with("resp_123")


def test_response_subcommand_json_renders_client_error_envelope():
    client = MagicMock()
    client.get_response.side_effect = CliError(
        "api_error",
        "backend failed",
        {"status_code": 500},
        EXIT_API_ERROR,
    )

    result = invoke_with_client(["response", "get", "resp_123", "--json"], client)

    assert result.exit_code == EXIT_API_ERROR
    payload = load_payload(result)
    assert payload["success"] is False
    assert payload["error"]["code"] == "api_error"
    assert payload["error"]["message"] == "backend failed"


def test_response_subcommand_non_json_renders_plain_error():
    client = MagicMock()
    client.get_response.side_effect = CliError(
        "api_error",
        "backend failed",
        {"status_code": 500},
        EXIT_API_ERROR,
    )

    result = invoke_with_client(["response", "get", "resp_123"], client)

    assert result.exit_code == EXIT_API_ERROR
    assert result.stderr == "Error: backend failed\n"
    assert not result.stderr.lstrip().startswith("{")


def test_ask_uses_explicit_model_without_default_lookup():
    client = MagicMock()
    client.create_response.return_value = assistant_response()

    with patch("wegent.commands.ask.get_mode") as get_mode_mock:
        result = invoke_with_client(
            ["ask", "hello", "--model", "custom#team", "--json"],
            client,
        )

    assert result.exit_code == 0
    assert json.loads(result.output)["data"]["id"] == "resp_1"
    get_mode_mock.assert_not_called()
    client.get_default_teams.assert_not_called()
    client.create_response.assert_called_once_with(
        {
            "model": "custom#team",
            "input": "hello",
            "tools": [{"type": "wegent_chat_bot"}],
        }
    )


def test_ask_requires_model_for_api_key_only_default_team_resolution():
    client = MagicMock()
    client.token = None
    client.api_key = "test-api-key"

    result = invoke_with_client(["ask", "hello", "--json"], client)

    assert result.exit_code != 0
    payload = load_payload(result)
    assert payload["success"] is False
    assert payload["error"]["code"] == "model_required_for_api_key_auth"
    client.get_default_teams.assert_not_called()
    client.create_response.assert_not_called()


def test_ask_uses_fresh_default_tools_for_each_payload():
    client = MagicMock()
    call_count = 0

    def create_response(payload):
        nonlocal call_count
        call_count += 1
        if call_count == 1:
            payload["tools"][0]["type"] = "mutated"
        return assistant_response()

    client.create_response.side_effect = create_response

    first_result = invoke_with_client(
        ["ask", "first", "--model", "custom#team"], client
    )
    second_result = invoke_with_client(
        ["ask", "second", "--model", "custom#team"],
        client,
    )

    assert first_result.exit_code == 0
    assert second_result.exit_code == 0
    assert client.create_response.call_args_list[1].args[0]["tools"] == [
        {"type": "wegent_chat_bot"}
    ]


def test_ask_resolves_default_team_by_mode():
    client = MagicMock()
    client.get_default_teams.return_value = {
        "chat": {"name": "wegent-chat", "namespace": "default"},
        "code": {"name": "code-agent", "namespace": "engineering"},
    }
    client.create_response.return_value = assistant_response()

    result = invoke_with_client(
        ["ask", "build this", "--mode", "code", "--json"], client
    )

    assert result.exit_code == 0
    client.get_default_teams.assert_called_once_with()
    client.create_response.assert_called_once_with(
        {
            "model": "engineering#code-agent",
            "input": "build this",
            "tools": [{"type": "wegent_chat_bot"}],
        }
    )


def test_ask_default_team_with_missing_namespace_uses_default_namespace():
    client = MagicMock()
    client.get_default_teams.return_value = {"chat": {"name": "chat-agent"}}
    client.create_response.return_value = assistant_response()

    result = invoke_with_client(["ask", "hello", "--mode", "chat", "--json"], client)

    assert result.exit_code == 0
    client.create_response.assert_called_once_with(
        {
            "model": "default#chat-agent",
            "input": "hello",
            "tools": [{"type": "wegent_chat_bot"}],
        }
    )


def test_ask_no_tools_omits_default_tool():
    client = MagicMock()
    client.create_response.return_value = assistant_response()

    result = invoke_with_client(
        ["ask", "hello", "--model", "custom#team", "--no-tools", "--json"],
        client,
    )

    assert result.exit_code == 0
    client.create_response.assert_called_once_with(
        {"model": "custom#team", "input": "hello"}
    )


def test_ask_returns_json_error_when_default_team_missing():
    client = MagicMock()
    client.get_default_teams.return_value = {"chat": None}

    result = invoke_with_client(["ask", "hello", "--mode", "chat", "--json"], client)

    assert result.exit_code != 0
    payload = load_payload(result)
    assert payload["success"] is False
    assert payload["error"]["code"] == "default_team_not_configured"
    assert payload["error"]["details"] == {"mode": "chat"}
    client.create_response.assert_not_called()


def test_ask_non_json_default_team_missing_renders_plain_error():
    client = MagicMock()
    client.get_default_teams.return_value = {"chat": None}

    result = invoke_with_client(["ask", "hello", "--mode", "chat"], client)

    assert result.exit_code != 0
    assert result.stderr.startswith("Error: No default team configured for mode: chat")
    assert not result.stderr.lstrip().startswith("{")
    client.create_response.assert_not_called()


def test_ask_non_json_prints_extracted_assistant_text():
    client = MagicMock()
    client.create_response.return_value = assistant_response("Plain answer")

    result = invoke_with_client(["ask", "hello", "--model", "custom#team"], client)

    assert result.exit_code == 0
    assert result.output == "Plain answer\n"


def test_ask_non_json_without_assistant_text_prints_json_response():
    client = MagicMock()
    response = {
        "id": "resp_1",
        "status": "completed",
        "output": [
            {
                "type": "message",
                "role": "tool",
                "content": [{"type": "output_text", "text": "tool output"}],
            }
        ],
    }
    client.create_response.return_value = response

    result = invoke_with_client(["ask", "hello", "--model", "custom#team"], client)

    assert result.exit_code == 0
    assert json.loads(result.output) == response
