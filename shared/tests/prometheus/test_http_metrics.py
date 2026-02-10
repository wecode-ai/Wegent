# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for HTTP Prometheus metrics (Backend and Chat Shell)."""

import pytest
from prometheus_client import CollectorRegistry

from shared.prometheus.metrics.backend_http import (
    BACKEND_HTTP_DURATION_BUCKETS,
    BackendHTTPMetrics,
    get_backend_http_metrics,
    reset_backend_http_metrics,
)
from shared.prometheus.metrics.chat_shell_http import (
    CHAT_SHELL_HTTP_DURATION_BUCKETS,
    ChatShellHTTPMetrics,
    get_chat_shell_http_metrics,
    reset_chat_shell_http_metrics,
)


@pytest.fixture(autouse=True)
def reset_metrics():
    """Reset global metrics instances before each test."""
    reset_backend_http_metrics()
    reset_chat_shell_http_metrics()
    yield
    reset_backend_http_metrics()
    reset_chat_shell_http_metrics()


@pytest.fixture
def test_registry():
    """Create a fresh registry for each test to avoid metric conflicts."""
    return CollectorRegistry()


class TestBackendHTTPMetrics:
    """Tests for BackendHTTPMetrics class."""

    def test_bucket_configuration(self):
        """Test Backend HTTP metrics bucket configuration."""
        expected_buckets = (
            0.1,
            0.25,
            0.5,
            0.75,
            1.0,
            2.5,
            5.0,
            7.5,
            10.0,
            float("inf"),
        )
        assert BACKEND_HTTP_DURATION_BUCKETS == expected_buckets

    def test_observe_request(self, test_registry):
        """Test Backend HTTP request metrics recording."""
        metrics = BackendHTTPMetrics(registry=test_registry)

        metrics.observe_request(
            method="GET",
            endpoint="/api/v1/tasks",
            status_code=200,
            duration_seconds=0.5,
        )

        # Verify counter was incremented
        assert (
            metrics.requests_total.labels(
                method="GET", endpoint="/api/v1/tasks", status_code="200"
            )._value.get()
            == 1.0
        )

    def test_observe_request_with_error_status(self, test_registry):
        """Test Backend HTTP request metrics with error status."""
        metrics = BackendHTTPMetrics(registry=test_registry)

        metrics.observe_request(
            method="POST",
            endpoint="/api/v1/tasks",
            status_code=500,
            duration_seconds=1.0,
        )

        assert (
            metrics.requests_total.labels(
                method="POST", endpoint="/api/v1/tasks", status_code="500"
            )._value.get()
            == 1.0
        )

    def test_in_progress_tracking(self, test_registry):
        """Test Backend HTTP in-progress request tracking."""
        metrics = BackendHTTPMetrics(registry=test_registry)

        # Increment in-progress
        metrics.inc_in_progress(method="GET", endpoint="/api/v1/tasks")
        assert (
            metrics.requests_in_progress.labels(
                method="GET", endpoint="/api/v1/tasks"
            )._value.get()
            == 1.0
        )

        # Decrement in-progress
        metrics.dec_in_progress(method="GET", endpoint="/api/v1/tasks")
        assert (
            metrics.requests_in_progress.labels(
                method="GET", endpoint="/api/v1/tasks"
            )._value.get()
            == 0.0
        )

    def test_metric_names_have_backend_prefix(self, test_registry):
        """Test that Backend metrics have correct prefix."""
        metrics = BackendHTTPMetrics(registry=test_registry)

        # Access metrics to trigger creation
        metrics.requests_total.labels(method="GET", endpoint="/test", status_code="200")
        metrics.request_duration.labels(
            method="GET", endpoint="/test", status_code="200"
        )
        metrics.requests_in_progress.labels(method="GET", endpoint="/test")

        # Verify metric names (Counter _name does not include _total suffix)
        assert metrics.requests_total._name == "backend_http_requests"
        assert metrics.request_duration._name == "backend_http_request_duration_seconds"
        assert metrics.requests_in_progress._name == "backend_http_requests_in_progress"


class TestChatShellHTTPMetrics:
    """Tests for ChatShellHTTPMetrics class."""

    def test_bucket_configuration(self):
        """Test Chat Shell HTTP metrics bucket configuration for LLM interactions."""
        expected_buckets = (
            1.0,
            5.0,
            10.0,
            30.0,
            60.0,
            120.0,
            300.0,
            600.0,
            900.0,
            1800.0,
            float("inf"),
        )
        assert CHAT_SHELL_HTTP_DURATION_BUCKETS == expected_buckets

    def test_observe_request(self, test_registry):
        """Test Chat Shell HTTP request metrics recording."""
        metrics = ChatShellHTTPMetrics(registry=test_registry)

        metrics.observe_request(
            method="POST",
            endpoint="/v1/response",
            status_code=200,
            duration_seconds=30.0,
        )

        # Verify counter was incremented
        assert (
            metrics.requests_total.labels(
                method="POST", endpoint="/v1/response", status_code="200"
            )._value.get()
            == 1.0
        )

    def test_observe_long_running_request(self, test_registry):
        """Test Chat Shell HTTP metrics for long-running LLM requests."""
        metrics = ChatShellHTTPMetrics(registry=test_registry)

        # Simulate a 10-minute LLM streaming response
        metrics.observe_request(
            method="POST",
            endpoint="/v1/response",
            status_code=200,
            duration_seconds=600.0,
        )

        histogram = metrics.request_duration.labels(
            method="POST", endpoint="/v1/response", status_code="200"
        )
        assert histogram._sum.get() == 600.0

    def test_in_progress_tracking(self, test_registry):
        """Test Chat Shell HTTP in-progress request tracking."""
        metrics = ChatShellHTTPMetrics(registry=test_registry)

        # Increment in-progress
        metrics.inc_in_progress(method="POST", endpoint="/v1/response")
        assert (
            metrics.requests_in_progress.labels(
                method="POST", endpoint="/v1/response"
            )._value.get()
            == 1.0
        )

        # Decrement in-progress
        metrics.dec_in_progress(method="POST", endpoint="/v1/response")
        assert (
            metrics.requests_in_progress.labels(
                method="POST", endpoint="/v1/response"
            )._value.get()
            == 0.0
        )

    def test_metric_names_have_chat_shell_prefix(self, test_registry):
        """Test that Chat Shell metrics have correct prefix."""
        metrics = ChatShellHTTPMetrics(registry=test_registry)

        # Access metrics to trigger creation
        metrics.requests_total.labels(
            method="POST", endpoint="/test", status_code="200"
        )
        metrics.request_duration.labels(
            method="POST", endpoint="/test", status_code="200"
        )
        metrics.requests_in_progress.labels(method="POST", endpoint="/test")

        # Verify metric names (Counter _name does not include _total suffix)
        assert metrics.requests_total._name == "chat_shell_http_requests"
        assert (
            metrics.request_duration._name == "chat_shell_http_request_duration_seconds"
        )
        assert (
            metrics.requests_in_progress._name == "chat_shell_http_requests_in_progress"
        )


class TestGlobalMetricsInstances:
    """Tests for global metrics singleton instances."""

    def test_get_backend_http_metrics_singleton(self):
        """Test that get_backend_http_metrics returns the same instance."""
        reset_backend_http_metrics()
        metrics1 = get_backend_http_metrics()
        metrics2 = get_backend_http_metrics()
        assert metrics1 is metrics2

    def test_get_chat_shell_http_metrics_singleton(self):
        """Test that get_chat_shell_http_metrics returns the same instance."""
        reset_chat_shell_http_metrics()
        metrics1 = get_chat_shell_http_metrics()
        metrics2 = get_chat_shell_http_metrics()
        assert metrics1 is metrics2

    def test_reset_clears_backend_instance(self):
        """Test that reset_backend_http_metrics clears the instance."""
        metrics1 = get_backend_http_metrics()
        reset_backend_http_metrics()
        metrics2 = get_backend_http_metrics()
        assert metrics1 is not metrics2

    def test_reset_clears_chat_shell_instance(self):
        """Test that reset_chat_shell_http_metrics clears the instance."""
        metrics1 = get_chat_shell_http_metrics()
        reset_chat_shell_http_metrics()
        metrics2 = get_chat_shell_http_metrics()
        assert metrics1 is not metrics2

    def test_backend_and_chat_shell_are_independent(self):
        """Test that Backend and Chat Shell metrics are independent."""
        backend_metrics = get_backend_http_metrics()
        chat_shell_metrics = get_chat_shell_http_metrics()

        # They should be different instances
        assert backend_metrics is not chat_shell_metrics

        # They should have different metric names
        backend_metrics.requests_total.labels(
            method="GET", endpoint="/test", status_code="200"
        )
        chat_shell_metrics.requests_total.labels(
            method="GET", endpoint="/test", status_code="200"
        )

        assert (
            backend_metrics.requests_total._name
            != chat_shell_metrics.requests_total._name
        )


class TestBucketConfigurationComparison:
    """Tests to verify bucket configurations are appropriate for their use cases."""

    def test_backend_buckets_optimized_for_rest_apis(self):
        """Test Backend buckets cover typical REST API response times."""
        # Backend buckets should have fine granularity for sub-second responses
        buckets = BACKEND_HTTP_DURATION_BUCKETS
        assert buckets[0] == 0.1  # 100ms - fast API responses
        assert buckets[1] == 0.25  # 250ms
        assert buckets[2] == 0.5  # 500ms
        assert 10.0 in buckets  # Cover up to 10s for slower operations
        assert buckets[-1] == float("inf")

    def test_chat_shell_buckets_optimized_for_llm_interactions(self):
        """Test Chat Shell buckets cover long-running LLM interactions."""
        buckets = CHAT_SHELL_HTTP_DURATION_BUCKETS

        # Chat Shell buckets should start at 1s (LLM always takes time)
        assert buckets[0] == 1.0

        # Should cover up to 30 minutes for very long streaming responses
        assert 1800.0 in buckets  # 30 minutes

        # Should have buckets for typical LLM response times
        assert 30.0 in buckets  # 30 seconds
        assert 60.0 in buckets  # 1 minute
        assert 300.0 in buckets  # 5 minutes
        assert 600.0 in buckets  # 10 minutes

        assert buckets[-1] == float("inf")

    def test_bucket_ranges_are_distinct_for_their_purposes(self):
        """Test that bucket configurations serve different purposes."""
        backend_buckets = set(BACKEND_HTTP_DURATION_BUCKETS)
        chat_shell_buckets = set(CHAT_SHELL_HTTP_DURATION_BUCKETS)

        # Backend should have small buckets that Chat Shell doesn't need
        small_backend_buckets = {b for b in backend_buckets if b < 1.0}
        assert len(small_backend_buckets) > 0  # Backend has sub-second buckets

        # Chat Shell should have large buckets that Backend doesn't have
        large_chat_shell_buckets = {b for b in chat_shell_buckets if b > 60.0}
        assert len(large_chat_shell_buckets) > 0  # Chat Shell has >1min buckets

        # Chat Shell should have much larger max bucket (excluding inf)
        backend_max = max(b for b in backend_buckets if b != float("inf"))
        chat_shell_max = max(b for b in chat_shell_buckets if b != float("inf"))
        assert chat_shell_max > backend_max  # Chat Shell supports longer requests
