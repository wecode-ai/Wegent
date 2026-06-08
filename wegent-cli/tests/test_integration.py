"""Opt-in integration tests for the Wegent CLI.

Run with:
  WEGENT_TEST_SERVER=http://localhost:8000 pytest tests/test_integration.py --integration -m integration

WEGENT_TEST_SERVER is required. WEGENT_TEST_TOKEN is optional and only needed
for backends that require authentication.
"""

import json
import os

import pytest
from click.testing import CliRunner

from wegent.cli import cli

pytestmark = pytest.mark.integration

ACCEPTED_ERROR_EXIT_CODES = {
    "auth_error": 2,
    "default_team_not_configured": 1,
}


def integration_env():
    server = os.environ["WEGENT_TEST_SERVER"]
    token = os.environ.get("WEGENT_TEST_TOKEN", "")
    return {"WEGENT_SERVER": server, "WEGENT_TOKEN": token}


def assert_accepted_smoke_result(result):
    try:
        payload = json.loads(result.output)
    except json.JSONDecodeError:
        pytest.fail(
            f"Integration smoke returned malformed JSON "
            f"(exit_code={result.exit_code}): {result.output}"
        )

    if payload.get("success") is True:
        assert result.exit_code == 0, (
            f"Success envelope must exit 0 "
            f"(exit_code={result.exit_code}): {result.output}"
        )
        return

    error = payload.get("error") if isinstance(payload, dict) else None
    code = error.get("code") if isinstance(error, dict) else None
    expected_exit_code = ACCEPTED_ERROR_EXIT_CODES.get(code)
    if expected_exit_code is not None:
        assert result.exit_code == expected_exit_code, (
            f"Accepted error {code!r} must exit {expected_exit_code} "
            f"(exit_code={result.exit_code}): {result.output}"
        )
        return

    pytest.fail(
        f"Integration smoke returned unacceptable outcome "
        f"(exit_code={result.exit_code}): {result.output}"
    )


def test_default_teams_endpoint_is_reachable_when_integration_requested():
    runner = CliRunner(env=integration_env())

    result = runner.invoke(cli, ["ask", "ping", "--json", "--no-tools"])

    assert_accepted_smoke_result(result)
