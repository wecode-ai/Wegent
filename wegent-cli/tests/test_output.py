"""Tests for wegent output formatting."""

import pytest
from datetime import datetime, timedelta

from wegent.output import (
    format_table,
    format_resource_list,
    format_age,
    format_describe,
)


class TestFormatTable:
    """Tests for table formatting."""

    def test_format_table_basic(self):
        """Test basic table formatting."""
        headers = ["name", "status"]
        rows = [["ghost1", "ready"], ["ghost2", "pending"]]
        result = format_table(headers, rows)

        assert "NAME" in result
        assert "STATUS" in result
        assert "ghost1" in result
        assert "ghost2" in result

    def test_format_table_empty(self):
        """Test empty table."""
        headers = ["name", "status"]
        rows = []
        result = format_table(headers, rows)
        assert result == "No resources found."


class TestFormatResourceList:
    """Tests for resource list formatting."""

    def test_format_resource_list(self):
        """Test formatting resource list."""
        resources = [
            {
                "metadata": {"name": "ghost1", "namespace": "default"},
                "status": {"state": "Available"},
            },
            {
                "metadata": {"name": "ghost2", "namespace": "prod"},
                "status": {"state": "Unavailable"},
            },
        ]
        result = format_resource_list(resources, "ghost")

        assert "ghost1" in result
        assert "ghost2" in result
        assert "default" in result
        assert "prod" in result

    def test_format_resource_list_empty(self):
        """Test empty resource list."""
        result = format_resource_list([], "ghost")
        assert "No ghosts found" in result


class TestFormatAge:
    """Tests for age formatting."""

    def test_format_age_seconds(self):
        """Test age in seconds."""
        now = datetime.now()
        timestamp = (now - timedelta(seconds=30)).strftime("%Y-%m-%dT%H:%M:%S")
        result = format_age(timestamp)
        assert result.endswith("s")

    def test_format_age_minutes(self):
        """Test age in minutes."""
        now = datetime.now()
        timestamp = (now - timedelta(minutes=5)).strftime("%Y-%m-%dT%H:%M:%S")
        result = format_age(timestamp)
        assert result.endswith("m")

    def test_format_age_hours(self):
        """Test age in hours."""
        now = datetime.now()
        timestamp = (now - timedelta(hours=3)).strftime("%Y-%m-%dT%H:%M:%S")
        result = format_age(timestamp)
        assert result.endswith("h")

    def test_format_age_days(self):
        """Test age in days."""
        now = datetime.now()
        timestamp = (now - timedelta(days=2)).strftime("%Y-%m-%dT%H:%M:%S")
        result = format_age(timestamp)
        assert result.endswith("d")

    def test_format_age_invalid(self):
        """Test invalid timestamp."""
        assert format_age(None) == "Unknown"
        assert format_age("invalid") == "Unknown"


class TestFormatDescribe:
    """Tests for describe formatting."""

    def test_format_describe(self):
        """Test describe formatting."""
        resource = {
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Ghost",
            "metadata": {
                "name": "my-ghost",
                "namespace": "default",
                "displayName": "My Ghost",
            },
            "spec": {
                "systemPrompt": "You are helpful.",
                "skills": ["code", "test"],
            },
            "status": {
                "state": "Available",
            },
        }
        result = format_describe(resource)

        assert "Name:         my-ghost" in result
        assert "Namespace:    default" in result
        assert "Kind:         Ghost" in result
        assert "Display Name: My Ghost" in result
        assert "state: Available" in result
        assert "systemPrompt:" in result
