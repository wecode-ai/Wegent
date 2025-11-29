"""Tests for wegent CLI commands."""

import pytest
from click.testing import CliRunner
from unittest.mock import patch, MagicMock

from wegent.cli import cli


@pytest.fixture
def runner():
    """Create CLI runner."""
    return CliRunner()


@pytest.fixture
def mock_client():
    """Create mock client that is properly injected."""
    mock = MagicMock()
    # Properly mock normalize_kind to return valid kinds
    valid_kinds = ['ghost', 'model', 'shell', 'bot', 'team', 'workspace', 'task', 'skill']
    def normalize(k):
        k = k.lower()
        if k.endswith('s') and k[:-1] in valid_kinds:
            return k[:-1]
        if k in valid_kinds:
            return k
        raise ValueError(f"Invalid kind: {k}")
    mock.normalize_kind.side_effect = normalize
    mock.list_resources.return_value = []
    with patch("wegent.cli.WegentClient", return_value=mock):
        yield mock


class TestCLI:
    """Tests for CLI commands."""

    def test_version(self, runner):
        """Test version command."""
        result = runner.invoke(cli, ["--version"])
        assert result.exit_code == 0
        assert "wegent" in result.output

    def test_help(self, runner):
        """Test help command."""
        result = runner.invoke(cli, ["--help"])
        assert result.exit_code == 0
        assert "wegent" in result.output
        assert "get" in result.output
        assert "apply" in result.output
        assert "delete" in result.output

    def test_api_resources(self, runner, mock_client):
        """Test api-resources command."""
        result = runner.invoke(cli, ["api-resources"])
        assert result.exit_code == 0
        assert "ghosts" in result.output
        assert "Ghost" in result.output


class TestGetCommand:
    """Tests for get command."""

    def test_get_help(self, runner):
        """Test get help."""
        result = runner.invoke(cli, ["get", "--help"])
        assert result.exit_code == 0
        assert "Get resources" in result.output

    def test_get_list(self, runner, mock_client):
        """Test get list command."""
        mock_client.list_resources.return_value = [
            {
                "metadata": {"name": "ghost1", "namespace": "default"},
                "status": {"state": "Available"},
            }
        ]
        result = runner.invoke(cli, ["get", "ghosts"])
        assert result.exit_code == 0
        assert "ghost1" in result.output


class TestConfigCommand:
    """Tests for config command."""

    def test_config_view(self, runner, mock_client):
        """Test config view command."""
        result = runner.invoke(cli, ["config", "view"])
        assert result.exit_code == 0
        assert "server" in result.output
        assert "namespace" in result.output


class TestCreateCommand:
    """Tests for create command."""

    def test_create_dry_run(self, runner, mock_client):
        """Test create with dry-run."""
        result = runner.invoke(cli, ["create", "ghost", "test-ghost", "--dry-run"])
        assert result.exit_code == 0
        assert "Ghost" in result.output
        assert "test-ghost" in result.output

    def test_create_invalid_kind(self, runner, mock_client):
        """Test create with invalid kind."""
        result = runner.invoke(cli, ["create", "invalidkind", "test", "--dry-run"])
        assert result.exit_code == 1
        assert "Invalid kind" in result.output
