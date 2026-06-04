import pytest
import yaml

from wegent.errors import (
    EXIT_API_ERROR,
    EXIT_AUTH_ERROR,
    EXIT_NETWORK_ERROR,
    EXIT_USAGE_ERROR,
    CliError,
)
from wegent.io import load_structured_input
from wegent.output import (
    dumps_json,
    dumps_yaml,
    error_envelope,
    extract_response_text,
    success_envelope,
)


def test_cli_error_defaults_to_usage_exit_code():
    error = CliError(code="invalid_input", message="Invalid input")

    assert error.exit_code == EXIT_USAGE_ERROR
    assert error.to_dict() == {
        "code": "invalid_input",
        "message": "Invalid input",
        "details": {},
    }


def test_cli_error_preserves_details_and_exit_code():
    error = CliError(
        code="api_error",
        message="Backend failed",
        details={"status_code": 500},
        exit_code=EXIT_API_ERROR,
    )

    assert error.exit_code == EXIT_API_ERROR
    assert error.to_dict()["details"] == {"status_code": 500}


def test_exit_code_constants_are_stable():
    assert EXIT_USAGE_ERROR == 1
    assert EXIT_AUTH_ERROR == 2
    assert EXIT_API_ERROR == 3
    assert EXIT_NETWORK_ERROR == 4


def test_success_envelope_wraps_data():
    assert success_envelope({"id": "resp_1"}) == {
        "success": True,
        "data": {"id": "resp_1"},
    }


def test_error_envelope_wraps_cli_error():
    error = CliError("default_team_not_configured", "No default team")

    assert error_envelope(error) == {
        "success": False,
        "error": {
            "code": "default_team_not_configured",
            "message": "No default team",
            "details": {},
        },
    }


def test_dumps_json_serializes_success_envelope_with_indentation():
    envelope = success_envelope({"id": "resp_1"})
    serialized = dumps_json(envelope)

    assert serialized.startswith('{\n  "success": true,')
    assert yaml.safe_load(serialized) == envelope


def test_dumps_yaml_serializes_simple_mapping():
    serialized = dumps_yaml({"success": True, "id": "resp_1"})

    assert yaml.safe_load(serialized) == {"success": True, "id": "resp_1"}


def test_extract_response_text_joins_assistant_chunks_only():
    response = {
        "output": [
            {
                "type": "message",
                "role": "assistant",
                "content": [
                    {"type": "output_text", "text": "Hello"},
                    {"type": "output_text", "text": "world"},
                ],
            },
            {
                "type": "message",
                "role": "user",
                "content": [{"type": "input_text", "text": "Ignore me"}],
            },
            {
                "type": "tool_call",
                "role": "assistant",
                "content": [{"type": "output_text", "text": "Ignore tool"}],
            },
        ]
    }

    assert extract_response_text(response) == "Hello\nworld"


def test_load_structured_input_reads_json_file(tmp_path):
    input_file = tmp_path / "payload.json"
    input_file.write_text('{"input": "hello"}')

    assert load_structured_input(str(input_file)) == {"input": "hello"}


def test_load_structured_input_reads_yaml_file(tmp_path):
    input_file = tmp_path / "payload.yaml"
    input_file.write_text("input: hello\n")

    assert load_structured_input(str(input_file)) == {"input": "hello"}


def test_load_structured_input_reads_stdin():
    assert load_structured_input("-", stdin_text='{"input": "hello"}') == {
        "input": "hello"
    }


def test_load_structured_input_raises_on_empty_stdin():
    with pytest.raises(CliError) as exc_info:
        load_structured_input("-", stdin_text="")

    assert exc_info.value.code == "empty_input"


def test_load_structured_input_raises_on_invalid_json_or_yaml(tmp_path):
    input_file = tmp_path / "payload.json"
    input_file.write_text("{")

    with pytest.raises(CliError) as exc_info:
        load_structured_input(str(input_file))

    assert exc_info.value.code == "invalid_input"


def test_load_structured_input_raises_file_read_error_on_invalid_utf8(tmp_path):
    input_file = tmp_path / "payload.json"
    input_file.write_bytes(b"\xff\xfe")

    with pytest.raises(CliError) as exc_info:
        load_structured_input(str(input_file))

    assert exc_info.value.code == "file_read_error"
