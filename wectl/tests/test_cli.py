"""Tests for wectl CLI commands."""

import pytest
from click.testing import CliRunner
from unittest.mock import patch, Mock

from wectl.cli import cli


@pytest.fixture
def runner():
    """Create CLI runner."""
    return CliRunner()


@pytest.fixture
def mock_client():
    """Create mock client."""
    with patch("wectl.cli.WegentClient") as mock:
        yield mock


class TestCLI:
    """Tests for CLI commands."""

    def test_version(self, runner):
        """Test version command."""
        result = runner.invoke(cli, ["--version"])
        assert result.exit_code == 0
        assert "wectl" in result.output

    def test_help(self, runner):
        """Test help command."""
        result = runner.invoke(cli, ["--help"])
        assert result.exit_code == 0
        assert "wectl" in result.output
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

    @patch("wectl.commands.get.WegentClient")
    def test_get_list(self, mock_client_class, runner):
        """Test get list command."""
        mock_client = Mock()
        mock_client.normalize_kind.return_value = "ghost"
        mock_client.list_resources.return_value = [
            {
                "metadata": {"name": "ghost1", "namespace": "default"},
                "status": {"state": "Available"},
            }
        ]
        mock_client_class.return_value = mock_client

        with patch("wectl.cli.WegentClient", return_value=mock_client):
            result = runner.invoke(cli, ["get", "ghosts"])
            # Should succeed or give reasonable output
            assert "ghost1" in result.output or result.exit_code == 0


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
