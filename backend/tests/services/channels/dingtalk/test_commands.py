# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for DingTalk command parser."""

import pytest

from app.services.channels.dingtalk.commands import (
    HELP_MESSAGE,
    CommandType,
    ParsedCommand,
    is_command,
    parse_command,
)


class TestParseCommand:
    """Tests for the parse_command function."""

    def test_parse_devices_command(self):
        """Test parsing /devices command."""
        result = parse_command("/devices")
        assert result is not None
        assert result.command == CommandType.DEVICES
        assert result.argument is None

    def test_parse_use_command_with_argument(self):
        """Test parsing /use command with device name."""
        result = parse_command("/use my-mac")
        assert result is not None
        assert result.command == CommandType.USE
        assert result.argument == "my-mac"

    def test_parse_use_command_with_cloud(self):
        """Test parsing /use cloud command."""
        result = parse_command("/use cloud")
        assert result is not None
        assert result.command == CommandType.USE
        assert result.argument == "cloud"

    def test_parse_use_command_without_argument(self):
        """Test parsing /use command without argument (switch to chat mode)."""
        result = parse_command("/use")
        assert result is not None
        assert result.command == CommandType.USE
        assert result.argument is None

    def test_parse_status_command(self):
        """Test parsing /status command."""
        result = parse_command("/status")
        assert result is not None
        assert result.command == CommandType.STATUS
        assert result.argument is None

    def test_parse_new_command(self):
        """Test parsing /new command."""
        result = parse_command("/new")
        assert result is not None
        assert result.command == CommandType.NEW
        assert result.argument is None

    def test_parse_help_command(self):
        """Test parsing /help command."""
        result = parse_command("/help")
        assert result is not None
        assert result.command == CommandType.HELP
        assert result.argument is None

    def test_parse_command_case_insensitive(self):
        """Test that command parsing is case insensitive."""
        result = parse_command("/DEVICES")
        assert result is not None
        assert result.command == CommandType.DEVICES

        result = parse_command("/Use Cloud")
        assert result is not None
        assert result.command == CommandType.USE
        assert result.argument == "Cloud"

    def test_parse_unknown_command(self):
        """Test parsing unknown command returns None."""
        result = parse_command("/unknown")
        assert result is None

    def test_parse_not_a_command(self):
        """Test parsing non-command content returns None."""
        result = parse_command("Hello world")
        assert result is None

    def test_parse_empty_string(self):
        """Test parsing empty string returns None."""
        result = parse_command("")
        assert result is None

    def test_parse_none(self):
        """Test parsing None returns None."""
        result = parse_command(None)
        assert result is None

    def test_parse_command_with_leading_whitespace(self):
        """Test parsing command with leading whitespace."""
        result = parse_command("  /devices")
        assert result is not None
        assert result.command == CommandType.DEVICES

        result = parse_command("   /use my-mac")
        assert result is not None
        assert result.command == CommandType.USE
        assert result.argument == "my-mac"

    def test_parse_command_with_extra_spaces(self):
        """Test parsing command with extra whitespace."""
        result = parse_command("/use   my-device  ")
        assert result is not None
        assert result.command == CommandType.USE
        assert result.argument == "my-device"


class TestIsCommand:
    """Tests for the is_command function."""

    def test_is_command_true(self):
        """Test is_command returns True for valid commands."""
        assert is_command("/devices") is True
        assert is_command("/use my-mac") is True
        assert is_command("/status") is True
        assert is_command("/new") is True
        assert is_command("/help") is True

    def test_is_command_false_for_unknown(self):
        """Test is_command returns False for unknown commands."""
        assert is_command("/unknown") is False

    def test_is_command_false_for_non_command(self):
        """Test is_command returns False for non-command content."""
        assert is_command("Hello world") is False
        assert is_command("") is False


class TestParsedCommand:
    """Tests for ParsedCommand dataclass."""

    def test_str_with_argument(self):
        """Test string representation with argument."""
        cmd = ParsedCommand(command=CommandType.USE, argument="my-mac")
        assert str(cmd) == "/use my-mac"

    def test_str_without_argument(self):
        """Test string representation without argument."""
        cmd = ParsedCommand(command=CommandType.DEVICES)
        assert str(cmd) == "/devices"


class TestHelpMessage:
    """Tests for help message content."""

    def test_help_message_contains_commands(self):
        """Test that help message contains all commands."""
        assert "/devices" in HELP_MESSAGE
        assert "/use" in HELP_MESSAGE
        assert "/status" in HELP_MESSAGE
        assert "/new" in HELP_MESSAGE
        assert "/help" in HELP_MESSAGE
