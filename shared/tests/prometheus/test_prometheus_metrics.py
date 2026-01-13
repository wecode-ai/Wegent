# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Unit tests for Prometheus metrics module.

Tests cover:
- Configuration loading
- Metrics registration and collection
- Path normalization
- Middleware functionality
- Response generation

NOTE: These tests require prometheus_client and starlette packages.
The tests will be skipped if the dependencies are not installed.
"""

import os
from unittest.mock import patch

import pytest

# Check if prometheus dependencies are available
try:
    from prometheus_client import CollectorRegistry

    from shared.telemetry.prometheus.config import (
        DEFAULT_EXCLUDE_PATHS,
        PrometheusConfig,
        get_prometheus_config,
        reset_prometheus_config,
        should_track_path,
    )
    from shared.telemetry.prometheus.metrics import (
        PrometheusMetrics,
        reset_prometheus_metrics,
    )
    from shared.telemetry.prometheus.middleware import normalize_path
    from shared.telemetry.prometheus.response import get_metrics_text

    PROMETHEUS_AVAILABLE = True
except ImportError:
    PROMETHEUS_AVAILABLE = False


pytestmark = pytest.mark.skipif(
    not PROMETHEUS_AVAILABLE,
    reason="prometheus_client or starlette not installed",
)


class TestPrometheusConfig:
    """Tests for PrometheusConfig and configuration loading."""

    def setup_method(self):
        """Reset config before each test."""
        reset_prometheus_config()

    def teardown_method(self):
        """Reset config after each test."""
        reset_prometheus_config()

    def test_default_config(self):
        """Test default configuration values."""
        config = get_prometheus_config()

        assert config.enabled is False
        assert config.metrics_path == "/metrics"
        assert config.metrics_prefix == ""  # Empty by default for compatibility
        assert config.exclude_paths == DEFAULT_EXCLUDE_PATHS

    def test_config_from_env_enabled(self):
        """Test configuration with PROMETHEUS_ENABLED=true."""
        with patch.dict(os.environ, {"PROMETHEUS_ENABLED": "true"}):
            reset_prometheus_config()
            config = get_prometheus_config()

            assert config.enabled is True

    def test_config_from_env_custom_path(self):
        """Test configuration with custom metrics path."""
        with patch.dict(
            os.environ,
            {
                "PROMETHEUS_ENABLED": "true",
                "PROMETHEUS_METRICS_PATH": "/custom/metrics",
            },
        ):
            reset_prometheus_config()
            config = get_prometheus_config()

            assert config.metrics_path == "/custom/metrics"

    def test_config_from_env_custom_prefix(self):
        """Test configuration with custom metrics prefix."""
        with patch.dict(
            os.environ,
            {
                "PROMETHEUS_ENABLED": "true",
                "PROMETHEUS_METRICS_PREFIX": "myapp_",
            },
        ):
            reset_prometheus_config()
            config = get_prometheus_config()

            assert config.metrics_prefix == "myapp_"

    def test_config_from_env_exclude_paths(self):
        """Test configuration with custom exclude paths."""
        with patch.dict(
            os.environ,
            {
                "PROMETHEUS_EXCLUDE_PATHS": "/health,/ready,/custom",
            },
        ):
            reset_prometheus_config()
            config = get_prometheus_config()

            assert config.exclude_paths == ["/health", "/ready", "/custom"]

    def test_config_service_name_override(self):
        """Test service name override."""
        config = get_prometheus_config("my-custom-service")

        assert config.service_name == "my-custom-service"

    def test_config_cached(self):
        """Test that configuration is cached."""
        config1 = get_prometheus_config()
        config2 = get_prometheus_config()

        assert config1 is config2


class TestShouldTrackPath:
    """Tests for should_track_path function."""

    def setup_method(self):
        """Reset config before each test."""
        reset_prometheus_config()

    def teardown_method(self):
        """Reset config after each test."""
        reset_prometheus_config()

    def test_track_regular_path(self):
        """Test that regular API paths are tracked."""
        assert should_track_path("/api/users") is True
        assert should_track_path("/api/tasks/123") is True

    def test_skip_health_paths(self):
        """Test that health check paths are skipped."""
        assert should_track_path("/health") is False
        assert should_track_path("/healthz") is False
        assert should_track_path("/ready") is False
        assert should_track_path("/metrics") is False

    def test_skip_root_path(self):
        """Test that root path is skipped."""
        assert should_track_path("/") is False

    def test_custom_exclude_paths(self):
        """Test custom exclude paths configuration."""
        config = PrometheusConfig(
            enabled=True,
            exclude_paths=["/internal/*", "/debug"],
        )

        assert should_track_path("/api/users", config) is True
        assert should_track_path("/internal/status", config) is False
        assert should_track_path("/internal/health", config) is False
        assert should_track_path("/debug", config) is False


class TestPrometheusMetrics:
    """Tests for PrometheusMetrics class."""

    def setup_method(self):
        """Create fresh registry for each test."""
        reset_prometheus_config()
        reset_prometheus_metrics()
        self.registry = CollectorRegistry()
        self.config = PrometheusConfig(
            enabled=True,
            service_name="test-service",
            metrics_prefix="test_",
        )

    def test_metrics_initialization(self):
        """Test that metrics are properly initialized."""
        metrics = PrometheusMetrics(config=self.config, registry=self.registry)

        assert metrics.http_requests_total is not None
        assert metrics.http_request_duration_seconds is not None
        assert metrics.http_request_duration_highr_seconds is not None
        assert metrics.http_request_size_bytes is not None
        assert metrics.http_response_size_bytes is not None
        assert metrics.http_requests_in_progress is not None

    def test_record_request_lifecycle(self):
        """Test recording request start and end."""
        metrics = PrometheusMetrics(config=self.config, registry=self.registry)

        # Start request
        metrics.record_request_start("GET", "/api/users")

        # End request with size information
        metrics.record_request_end(
            "GET", "/api/users", 200, 0.5, request_size=100, response_size=500
        )

        # Verify metrics were recorded (basic check that no exceptions)
        # Full verification would require checking metric values

    def test_record_request_with_sizes(self):
        """Test recording request with body sizes."""
        metrics = PrometheusMetrics(config=self.config, registry=self.registry)

        metrics.record_request_start("POST", "/api/data")
        metrics.record_request_end(
            method="POST",
            path="/api/data",
            status_code=201,
            duration=0.3,
            request_size=1024,
            response_size=2048,
        )

        # Verify size metrics are recorded
        text = get_metrics_text(self.registry)
        assert "test_http_request_size_bytes" in text
        assert "test_http_response_size_bytes" in text

    def test_register_custom_counter(self):
        """Test registering a custom counter."""
        metrics = PrometheusMetrics(config=self.config, registry=self.registry)

        counter = metrics.register_custom_counter(
            "tasks_created_total",
            "Total number of tasks created",
            labelnames=["task_type"],
        )

        assert counter is not None
        counter.labels(task_type="chat").inc()

    def test_register_custom_gauge(self):
        """Test registering a custom gauge."""
        metrics = PrometheusMetrics(config=self.config, registry=self.registry)

        gauge = metrics.register_custom_gauge(
            "active_sessions",
            "Number of active sessions",
            labelnames=["session_type"],
        )

        assert gauge is not None
        gauge.labels(session_type="websocket").set(10)

    def test_register_custom_histogram(self):
        """Test registering a custom histogram."""
        metrics = PrometheusMetrics(config=self.config, registry=self.registry)

        histogram = metrics.register_custom_histogram(
            "llm_response_duration_seconds",
            "LLM response duration",
            labelnames=["model"],
        )

        assert histogram is not None
        histogram.labels(model="claude-3").observe(1.5)

    def test_custom_metric_deduplication(self):
        """Test that registering same metric twice returns same instance."""
        metrics = PrometheusMetrics(config=self.config, registry=self.registry)

        counter1 = metrics.register_custom_counter("my_counter", "Description")
        counter2 = metrics.register_custom_counter("my_counter", "Description")

        assert counter1 is counter2


class TestPathNormalization:
    """Tests for path normalization."""

    def test_normalize_numeric_id(self):
        """Test normalizing numeric IDs in paths."""
        assert normalize_path("/api/users/123") == "/api/users/{id}"
        assert (
            normalize_path("/api/tasks/456/subtasks/789")
            == "/api/tasks/{id}/subtasks/{id}"
        )

    def test_normalize_uuid(self):
        """Test normalizing UUIDs in paths."""
        path = "/api/sessions/550e8400-e29b-41d4-a716-446655440000"
        assert normalize_path(path) == "/api/sessions/{uuid}"

    def test_preserve_static_paths(self):
        """Test that static paths are not modified."""
        assert normalize_path("/api/users") == "/api/users"
        assert normalize_path("/api/health") == "/api/health"

    def test_complex_path_normalization(self):
        """Test normalization of complex paths."""
        path = (
            "/api/tasks/123/subtasks/550e8400-e29b-41d4-a716-446655440000/comments/456"
        )
        expected = "/api/tasks/{id}/subtasks/{uuid}/comments/{id}"
        assert normalize_path(path) == expected


class TestMetricsResponse:
    """Tests for metrics response generation."""

    def setup_method(self):
        """Reset metrics before each test."""
        reset_prometheus_config()
        reset_prometheus_metrics()

    def test_get_metrics_text(self):
        """Test getting metrics as text."""
        # Create a fresh registry for testing
        registry = CollectorRegistry()
        config = PrometheusConfig(
            enabled=True,
            service_name="test-service",
            metrics_prefix="test_",
        )
        metrics = PrometheusMetrics(config=config, registry=registry)

        # Record some data
        metrics.record_request_start("GET", "/api/test")
        metrics.record_request_end("GET", "/api/test", 200, 0.1)

        # Get metrics text
        text = get_metrics_text(registry)

        assert "test_http_requests_total" in text
        assert "test_http_request_duration_seconds" in text
        assert "test_http_request_duration_highr_seconds" in text
