import json

import pytest

from wegent.errors import (
    EXIT_API_ERROR,
    EXIT_AUTH_ERROR,
    EXIT_NETWORK_ERROR,
    EXIT_USAGE_ERROR,
    CliError,
)
from wegent.io import load_structured_input
from wegent.output import error_envelope, success_envelope


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
