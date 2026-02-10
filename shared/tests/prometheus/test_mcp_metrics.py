# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for MCP Prometheus metrics."""

import pytest
from prometheus_client import REGISTRY, CollectorRegistry

from shared.prometheus.metrics.llm import (
    MCPMetrics,
    SkillMetrics,
    get_mcp_metrics,
    get_skill_metrics,
    reset_llm_metrics,
)


@pytest.fixture(autouse=True)
def reset_metrics():
    """Reset global metrics instances before each test."""
    reset_llm_metrics()
    yield
    reset_llm_metrics()


@pytest.fixture
def test_registry():
    """Create a fresh registry for each test to avoid metric conflicts."""
    return CollectorRegistry()


class TestMCPMetrics:
    """Tests for MCPMetrics class."""

    def test_observe_request(self, test_registry):
        """Test MCP tool request metrics recording."""
        metrics = MCPMetrics(registry=test_registry)

        metrics.observe_request(
            server="test-server",
            tool="test-tool",
            status="success",
            duration_seconds=0.5,
        )

        # Verify counter was incremented
        assert (
            metrics.requests_total.labels(
                server="test-server", tool="test-tool", status="success"
            )._value.get()
            == 1.0
        )

    def test_observe_request_with_error_status(self, test_registry):
        """Test MCP tool request metrics with error status."""
        metrics = MCPMetrics(registry=test_registry)

        metrics.observe_request(
            server="test-server",
            tool="test-tool",
            status="error",
            duration_seconds=1.0,
        )

        assert (
            metrics.requests_total.labels(
                server="test-server", tool="test-tool", status="error"
            )._value.get()
            == 1.0
        )

    def test_observe_request_with_timeout_status(self, test_registry):
        """Test MCP tool request metrics with timeout status."""
        metrics = MCPMetrics(registry=test_registry)

        metrics.observe_request(
            server="test-server",
            tool="test-tool",
            status="timeout",
            duration_seconds=60.0,
        )

        assert (
            metrics.requests_total.labels(
                server="test-server", tool="test-tool", status="timeout"
            )._value.get()
            == 1.0
        )

    def test_observe_connection_success(self, test_registry):
        """Test MCP connection metrics with success status."""
        metrics = MCPMetrics(registry=test_registry)

        metrics.observe_connection(server="test-server", status="success")

        assert (
            metrics.connections_total.labels(
                server="test-server", status="success"
            )._value.get()
            == 1.0
        )

    def test_observe_connection_error(self, test_registry):
        """Test MCP connection metrics with error status."""
        metrics = MCPMetrics(registry=test_registry)

        metrics.observe_connection(server="test-server", status="error")

        assert (
            metrics.connections_total.labels(
                server="test-server", status="error"
            )._value.get()
            == 1.0
        )

    def test_observe_connection_timeout(self, test_registry):
        """Test MCP connection metrics with timeout status."""
        metrics = MCPMetrics(registry=test_registry)

        metrics.observe_connection(server="test-server", status="timeout")

        assert (
            metrics.connections_total.labels(
                server="test-server", status="timeout"
            )._value.get()
            == 1.0
        )

    def test_observe_disconnection(self, test_registry):
        """Test MCP disconnection metrics."""
        metrics = MCPMetrics(registry=test_registry)

        metrics.observe_disconnection(server="test-server")

        assert (
            metrics.disconnections_total.labels(server="test-server")._value.get()
            == 1.0
        )

    def test_observe_tool_discovery_success(self, test_registry):
        """Test MCP tool discovery metrics with success status."""
        metrics = MCPMetrics(registry=test_registry)

        metrics.observe_tool_discovery(
            server="test-server", status="success", duration_seconds=0.3
        )

        # Verify histogram sum contains the observation
        # (checking _sum attribute as histogram observation is harder to verify)
        histogram = metrics.tool_discovery_duration.labels(
            server="test-server", status="success"
        )
        assert histogram._sum.get() == 0.3

    def test_observe_tool_discovery_error(self, test_registry):
        """Test MCP tool discovery metrics with error status."""
        metrics = MCPMetrics(registry=test_registry)

        metrics.observe_tool_discovery(
            server="test-server", status="error", duration_seconds=5.0
        )

        histogram = metrics.tool_discovery_duration.labels(
            server="test-server", status="error"
        )
        assert histogram._sum.get() == 5.0

    def test_multiple_servers(self, test_registry):
        """Test metrics for multiple MCP servers."""
        metrics = MCPMetrics(registry=test_registry)

        # Record metrics for multiple servers
        metrics.observe_connection(server="server-1", status="success")
        metrics.observe_connection(server="server-2", status="success")
        metrics.observe_connection(server="server-3", status="error")

        assert (
            metrics.connections_total.labels(
                server="server-1", status="success"
            )._value.get()
            == 1.0
        )
        assert (
            metrics.connections_total.labels(
                server="server-2", status="success"
            )._value.get()
            == 1.0
        )
        assert (
            metrics.connections_total.labels(
                server="server-3", status="error"
            )._value.get()
            == 1.0
        )


class TestSkillMetrics:
    """Tests for SkillMetrics class."""

    def test_observe_request_success(self, test_registry):
        """Test Skill request metrics with success status."""
        metrics = SkillMetrics(registry=test_registry)

        metrics.observe_request(
            skill_name="test-skill", status="success", duration_seconds=0.1
        )

        assert (
            metrics.requests_total.labels(
                skill_name="test-skill", status="success"
            )._value.get()
            == 1.0
        )

    def test_observe_request_cached(self, test_registry):
        """Test Skill request metrics with cached status."""
        metrics = SkillMetrics(registry=test_registry)

        metrics.observe_request(
            skill_name="test-skill", status="cached", duration_seconds=0.01
        )

        assert (
            metrics.requests_total.labels(
                skill_name="test-skill", status="cached"
            )._value.get()
            == 1.0
        )

    def test_observe_request_error(self, test_registry):
        """Test Skill request metrics with error status."""
        metrics = SkillMetrics(registry=test_registry)

        metrics.observe_request(
            skill_name="test-skill", status="error", duration_seconds=0.05
        )

        assert (
            metrics.requests_total.labels(
                skill_name="test-skill", status="error"
            )._value.get()
            == 1.0
        )


class TestGlobalMetricsInstances:
    """Tests for global metrics singleton instances."""

    def test_get_mcp_metrics_singleton(self):
        """Test that get_mcp_metrics returns the same instance."""
        reset_llm_metrics()
        metrics1 = get_mcp_metrics()
        metrics2 = get_mcp_metrics()
        assert metrics1 is metrics2

    def test_get_skill_metrics_singleton(self):
        """Test that get_skill_metrics returns the same instance."""
        reset_llm_metrics()
        metrics1 = get_skill_metrics()
        metrics2 = get_skill_metrics()
        assert metrics1 is metrics2

    def test_reset_clears_instances(self):
        """Test that reset_llm_metrics clears all instances."""
        metrics1 = get_mcp_metrics()
        reset_llm_metrics()
        metrics2 = get_mcp_metrics()
        assert metrics1 is not metrics2
