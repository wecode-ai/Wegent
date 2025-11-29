"""Integration tests for wectl CLI.

These tests require a running Wegent backend service.
Run with: pytest tests/test_integration.py -v --integration

Environment variables:
  WECTL_TEST_SERVER: Backend API URL (default: http://localhost:8000)
  WECTL_TEST_TOKEN: Auth token for API (optional)
"""

import os
import uuid
import pytest
from click.testing import CliRunner

from wectl.cli import cli
from wectl.client import WegentClient, APIError


# Skip if not running integration tests
pytestmark = pytest.mark.integration


def pytest_configure(config):
    """Register integration marker."""
    config.addinivalue_line(
        "markers", "integration: mark test as integration test"
    )


@pytest.fixture(scope="module")
def server_url():
    """Get test server URL."""
    return os.environ.get("WECTL_TEST_SERVER", "http://localhost:8000")


@pytest.fixture(scope="module")
def token():
    """Get test token."""
    return os.environ.get("WECTL_TEST_TOKEN")


@pytest.fixture(scope="module")
def client(server_url, token):
    """Create test client."""
    return WegentClient(server=server_url, token=token)


@pytest.fixture(scope="module")
def runner(server_url, token):
    """Create CLI runner with environment."""
    runner = CliRunner(env={
        "WECTL_SERVER": server_url,
        "WECTL_TOKEN": token or "",
    })
    return runner


@pytest.fixture
def unique_name():
    """Generate unique resource name for testing."""
    return f"test-{uuid.uuid4().hex[:8]}"


class TestServerConnection:
    """Test server connectivity."""

    def test_server_reachable(self, client):
        """Test that the server is reachable."""
        try:
            # Try to list ghosts - this should work even if empty
            result = client.list_resources("ghost", "default")
            assert isinstance(result, list)
        except APIError as e:
            if e.status_code == 401:
                pytest.skip("Authentication required but no token provided")
            raise

    def test_api_resources_command(self, runner):
        """Test api-resources command."""
        result = runner.invoke(cli, ["api-resources"])
        assert result.exit_code == 0
        assert "ghosts" in result.output
        assert "bots" in result.output


class TestGhostLifecycle:
    """Test Ghost resource lifecycle."""

    def test_create_ghost(self, runner, unique_name):
        """Test creating a ghost."""
        result = runner.invoke(cli, ["create", "ghost", unique_name, "--dry-run"])
        assert result.exit_code == 0
        assert unique_name in result.output
        assert "Ghost" in result.output

    def test_list_ghosts(self, runner):
        """Test listing ghosts."""
        result = runner.invoke(cli, ["get", "ghosts"])
        # Should succeed even if no ghosts exist
        assert result.exit_code == 0

    def test_list_ghosts_yaml(self, runner):
        """Test listing ghosts in YAML format."""
        result = runner.invoke(cli, ["get", "ghosts", "-o", "yaml"])
        assert result.exit_code == 0
        assert "items:" in result.output or "No ghosts" in result.output

    def test_list_ghosts_json(self, runner):
        """Test listing ghosts in JSON format."""
        result = runner.invoke(cli, ["get", "ghosts", "-o", "json"])
        assert result.exit_code == 0
        # Should be valid JSON
        import json
        data = json.loads(result.output)
        assert "items" in data


class TestApplyAndDelete:
    """Test apply and delete operations."""

    def test_apply_from_stdin_dry_run(self, runner, unique_name, tmp_path):
        """Test applying resource from file."""
        # Create a temporary YAML file
        yaml_content = f"""
apiVersion: agent.wecode.io/v1
kind: Ghost
metadata:
  name: {unique_name}
  namespace: default
spec:
  systemPrompt: "Test ghost for integration testing"
  mcpServers: {{}}
  skills: []
"""
        yaml_file = tmp_path / "ghost.yaml"
        yaml_file.write_text(yaml_content)

        # Apply the file
        result = runner.invoke(cli, ["apply", "-f", str(yaml_file)])

        # If succeeded, clean up
        if result.exit_code == 0 and "created" in result.output.lower():
            runner.invoke(cli, ["delete", "ghost", unique_name, "-y"])


class TestConfigCommand:
    """Test config command."""

    def test_config_view(self, runner):
        """Test config view command."""
        result = runner.invoke(cli, ["config", "view"])
        assert result.exit_code == 0
        assert "server:" in result.output
        assert "namespace:" in result.output


class TestErrorHandling:
    """Test error handling."""

    def test_get_nonexistent_resource(self, runner):
        """Test getting a resource that doesn't exist."""
        result = runner.invoke(cli, ["get", "ghost", "nonexistent-ghost-12345"])
        # Should fail with appropriate error
        assert result.exit_code != 0 or "not found" in result.output.lower() or "error" in result.output.lower()

    def test_invalid_kind(self, runner):
        """Test using an invalid resource kind."""
        result = runner.invoke(cli, ["get", "invalidkind"])
        assert result.exit_code != 0
        assert "Invalid kind" in result.output or "error" in result.output.lower()


class TestNamespaceSupport:
    """Test namespace functionality."""

    def test_list_with_namespace(self, runner):
        """Test listing resources with namespace flag."""
        result = runner.invoke(cli, ["get", "ghosts", "-n", "default"])
        assert result.exit_code == 0

    def test_list_with_nonexistent_namespace(self, runner):
        """Test listing from non-existent namespace."""
        result = runner.invoke(cli, ["get", "ghosts", "-n", "nonexistent-ns-12345"])
        # Should succeed but return empty
        assert result.exit_code == 0


class TestResourceAliases:
    """Test resource type aliases."""

    def test_ghost_alias(self, runner):
        """Test gh alias for ghost."""
        result = runner.invoke(cli, ["get", "gh"])
        assert result.exit_code == 0

    def test_bot_alias(self, runner):
        """Test bo alias for bot."""
        result = runner.invoke(cli, ["get", "bo"])
        assert result.exit_code == 0

    def test_team_alias(self, runner):
        """Test te alias for team."""
        result = runner.invoke(cli, ["get", "te"])
        assert result.exit_code == 0

    def test_task_alias(self, runner):
        """Test ta alias for task."""
        result = runner.invoke(cli, ["get", "ta"])
        assert result.exit_code == 0


class TestOutputFormats:
    """Test output format options."""

    def test_yaml_output(self, runner):
        """Test YAML output format."""
        result = runner.invoke(cli, ["get", "models", "-o", "yaml"])
        assert result.exit_code == 0

    def test_json_output(self, runner):
        """Test JSON output format."""
        result = runner.invoke(cli, ["get", "shells", "-o", "json"])
        assert result.exit_code == 0
        # Verify it's valid JSON
        import json
        json.loads(result.output)
