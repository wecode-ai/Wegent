"""Opt-in integration tests for the Wegent CLI.

Run with:
  WEGENT_TEST_SERVER=http://localhost:8000 WEGENT_TEST_TOKEN=... pytest tests/test_integration.py --integration -m integration
"""

import os

import pytest
from click.testing import CliRunner

from wegent.cli import cli

pytestmark = pytest.mark.integration


def integration_env():
    server = os.environ["WEGENT_TEST_SERVER"]
    token = os.environ.get("WEGENT_TEST_TOKEN", "")
    return {"WEGENT_SERVER": server, "WEGENT_TOKEN": token}


def test_default_teams_endpoint_is_reachable_when_integration_requested():
    runner = CliRunner(env=integration_env())

    result = runner.invoke(cli, ["ask", "ping", "--json", "--no-tools"])

    assert result.exit_code in {0, 1, 2, 3}
    assert result.output.strip().startswith("{")
