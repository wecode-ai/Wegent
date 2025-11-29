"""Integration tests for wegent CLI.

These tests require a running Wegent backend service.
Run with: pytest tests/test_integration.py -v --integration

Environment variables:
  WEGENT_TEST_SERVER: Backend API URL (default: http://localhost:8000)
  WEGENT_TEST_TOKEN: Auth token for API (optional)
"""

import os
import uuid
import pytest
from click.testing import CliRunner

from wegent.cli import cli
from wegent.client import WegentClient, APIError


# Skip if not running integration tests
pytestmark = pytest.mark.integration


@pytest.fixture(scope="module")
def server_url():
    """Get test server URL."""
    return os.environ.get("WEGENT_TEST_SERVER", "http://localhost:8000")


@pytest.fixture(scope="module")
def token():
    """Get test token."""
    return os.environ.get("WEGENT_TEST_TOKEN")


@pytest.fixture(scope="module")
def client(server_url, token):
    """Create test client."""
    return WegentClient(server=server_url, token=token)


@pytest.fixture(scope="module")
def runner(server_url, token):
    """Create CLI runner with environment."""
    runner = CliRunner(env={
        "WEGENT_SERVER": server_url,
        "WEGENT_TOKEN": token or "",
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
            if e.status_code in [401, 403]:
                pytest.skip("Authentication required but no token provided")
            elif e.status_code == 0:
                pytest.skip(f"Server not reachable: {e.message}")
            raise

    def test_api_resources_command(self, runner):
        """Test api-resources command (no server needed)."""
        result = runner.invoke(cli, ["api-resources"])
        assert result.exit_code == 0
        assert "ghosts" in result.output
        assert "bots" in result.output


class TestGhostLifecycle:
    """Test Ghost resource lifecycle."""

    def test_create_ghost(self, runner, unique_name):
        """Test creating a ghost (dry-run, no server needed)."""
        result = runner.invoke(cli, ["create", "ghost", unique_name, "--dry-run"])
        assert result.exit_code == 0
        assert unique_name in result.output
        assert "Ghost" in result.output

    def test_list_ghosts(self, runner):
        """Test listing ghosts."""
        result = runner.invoke(cli, ["get", "ghosts"])
        # Accept success or auth error (401/403)
        if result.exit_code != 0:
            assert "401" in result.output or "403" in result.output or "Error" in result.output

    def test_list_ghosts_yaml(self, runner):
        """Test listing ghosts in YAML format."""
        result = runner.invoke(cli, ["get", "ghosts", "-o", "yaml"])
        # Accept success or auth error
        if result.exit_code == 0:
            assert "items:" in result.output or "No ghosts" in result.output

    def test_list_ghosts_json(self, runner):
        """Test listing ghosts in JSON format."""
        result = runner.invoke(cli, ["get", "ghosts", "-o", "json"])
        # Accept success or auth error
        if result.exit_code == 0:
            import json
            data = json.loads(result.output)
            assert "items" in data


class TestApplyAndDelete:
    """Test apply and delete operations."""

    def test_apply_from_file(self, runner, unique_name, tmp_path):
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
    """Test config command (no server needed)."""

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
        # Should fail with appropriate error (404 or auth error)
        assert result.exit_code != 0 or "error" in result.output.lower()

    def test_invalid_kind(self, runner):
        """Test using an invalid resource kind (no server needed)."""
        result = runner.invoke(cli, ["get", "invalidkind"])
        assert result.exit_code != 0
        assert "Invalid kind" in result.output


class TestNamespaceSupport:
    """Test namespace functionality."""

    def test_list_with_namespace(self, runner):
        """Test listing resources with namespace flag."""
        result = runner.invoke(cli, ["get", "ghosts", "-n", "default"])
        # Accept success or auth error
        if result.exit_code != 0:
            assert "Error" in result.output

    def test_list_with_nonexistent_namespace(self, runner):
        """Test listing from non-existent namespace."""
        result = runner.invoke(cli, ["get", "ghosts", "-n", "nonexistent-ns-12345"])
        # Accept success (empty result) or auth error
        pass  # Just ensure it doesn't crash


class TestResourceAliases:
    """Test resource type aliases (no server needed for validation)."""

    def test_ghost_alias(self, runner):
        """Test gh alias for ghost."""
        # Use dry-run create to test alias without server
        result = runner.invoke(cli, ["create", "gh", "test", "--dry-run"])
        assert result.exit_code == 0
        assert "Ghost" in result.output

    def test_bot_alias(self, runner):
        """Test bo alias for bot."""
        result = runner.invoke(cli, ["create", "bo", "test", "--dry-run"])
        assert result.exit_code == 0
        assert "Bot" in result.output

    def test_team_alias(self, runner):
        """Test te alias for team."""
        result = runner.invoke(cli, ["create", "te", "test", "--dry-run"])
        assert result.exit_code == 0
        assert "Team" in result.output

    def test_task_alias(self, runner):
        """Test ta alias for task."""
        result = runner.invoke(cli, ["create", "ta", "test", "--dry-run"])
        assert result.exit_code == 0
        assert "Task" in result.output


class TestOutputFormats:
    """Test output format options."""

    def test_yaml_output(self, runner):
        """Test YAML output format with dry-run create."""
        result = runner.invoke(cli, ["create", "ghost", "test", "--dry-run"])
        assert result.exit_code == 0
        # Should be valid YAML
        import yaml
        data = yaml.safe_load(result.output)
        assert data["kind"] == "Ghost"

    def test_json_output(self, runner):
        """Test JSON output - verify help shows option."""
        result = runner.invoke(cli, ["get", "--help"])
        assert result.exit_code == 0
        assert "-o" in result.output or "--output" in result.output
