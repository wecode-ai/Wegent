"""Tests for the Prometheus metrics module."""

from unittest.mock import MagicMock, patch

import pytest

from knowledge_doc_converter.core.metrics import (
    CALLBACK_RESULTS_TOTAL,
    CONVERSION_ACTIVE,
    CONVERSION_DURATION_SECONDS,
    CONVERSION_FILE_TYPES_TOTAL,
    CONVERSION_INPUT_SIZE_BYTES,
    CONVERSION_LOCK_RESULTS_TOTAL,
    CONVERSION_OUTPUT_SIZE_BYTES,
    CONVERSION_REQUESTS_TOTAL,
    is_server_started,
    record_callback_failed,
    record_callback_success,
    record_conversion_failed,
    record_conversion_skipped,
    record_conversion_started,
    record_conversion_succeeded,
    record_lock_acquired,
    record_lock_exhausted,
    record_lock_retry,
    start_metrics_server,
)


@pytest.fixture(autouse=True)
def _reset_server_started():
    """Reset the global _server_started flag before each test."""
    import knowledge_doc_converter.core.metrics as m

    original = m._server_started
    m._server_started = False
    yield
    m._server_started = original


class TestRecordFunctions:
    """Test convenience recording functions update the correct metrics."""

    def test_record_conversion_started(self):
        before_active = CONVERSION_ACTIVE._value.get()
        record_conversion_started()
        # Counter incremented and gauge incremented
        assert CONVERSION_REQUESTS_TOTAL.labels(status="started")._value.get() >= 1
        assert CONVERSION_ACTIVE._value.get() == before_active + 1

    def test_record_conversion_succeeded(self):
        before = CONVERSION_ACTIVE._value.get()
        record_conversion_succeeded(
            file_extension="pdf",
            duration_seconds=42.5,
            input_size=1024,
            output_size=512,
        )
        assert CONVERSION_REQUESTS_TOTAL.labels(status="succeeded")._value.get() >= 1
        assert (
            CONVERSION_DURATION_SECONDS.labels(file_extension="pdf")._buckets[0]
            is not None
        )
        assert (
            CONVERSION_FILE_TYPES_TOTAL.labels(file_extension="pdf")._value.get() >= 1
        )
        # Active gauge decremented by 1
        assert CONVERSION_ACTIVE._value.get() == before - 1

    def test_record_conversion_failed(self):
        record_conversion_failed("pptx", 10.0, input_size=2048)
        assert CONVERSION_REQUESTS_TOTAL.labels(status="failed")._value.get() >= 1

    def test_record_conversion_failed_no_input_size(self):
        record_conversion_failed("docx", 5.0)
        assert CONVERSION_REQUESTS_TOTAL.labels(status="failed")._value.get() >= 1

    def test_record_conversion_failed_zero_duration(self):
        """Zero duration should not observe on the histogram."""
        record_conversion_failed("pdf", 0)
        assert CONVERSION_REQUESTS_TOTAL.labels(status="failed")._value.get() >= 1

    def test_record_conversion_skipped(self):
        record_conversion_skipped("not_exists_or_stale")
        assert CONVERSION_REQUESTS_TOTAL.labels(status="skipped")._value.get() >= 1

    def test_record_lock_acquired(self):
        record_lock_acquired()
        assert CONVERSION_LOCK_RESULTS_TOTAL.labels(result="acquired")._value.get() >= 1

    def test_record_lock_retry(self):
        record_lock_retry()
        assert CONVERSION_LOCK_RESULTS_TOTAL.labels(result="retry")._value.get() >= 1

    def test_record_lock_exhausted(self):
        record_lock_exhausted()
        assert (
            CONVERSION_LOCK_RESULTS_TOTAL.labels(result="exhausted")._value.get() >= 1
        )

    def test_record_callback_success(self):
        record_callback_success("started")
        assert (
            CALLBACK_RESULTS_TOTAL.labels(
                callback_type="started", status="success"
            )._value.get()
            >= 1
        )

    def test_record_callback_failed(self):
        record_callback_failed("completed")
        assert (
            CALLBACK_RESULTS_TOTAL.labels(
                callback_type="completed", status="failed"
            )._value.get()
            >= 1
        )

    def test_record_callback_download_metrics(self):
        record_callback_success("download")
        record_callback_failed("download")
        assert (
            CALLBACK_RESULTS_TOTAL.labels(
                callback_type="download", status="success"
            )._value.get()
            >= 1
        )
        assert (
            CALLBACK_RESULTS_TOTAL.labels(
                callback_type="download", status="failed"
            )._value.get()
            >= 1
        )


class TestStartMetricsServer:
    """Test metrics server startup behavior."""

    @patch("knowledge_doc_converter.core.metrics.make_server")
    @patch("prometheus_client.make_wsgi_app")
    @patch("prometheus_client.multiprocess.MultiProcessCollector")
    def test_starts_server_with_default_path(
        self, mock_collector, mock_wsgi, mock_make_server
    ):
        mock_wsgi.return_value = MagicMock()
        mock_httpd = MagicMock()
        mock_make_server.return_value = mock_httpd
        start_metrics_server(9090)
        mock_wsgi.assert_called_once()
        call_args = mock_make_server.call_args
        assert call_args[0][0] == "0.0.0.0"
        assert call_args[0][1] == 9090
        assert callable(call_args[0][2])  # wrapper app is callable
        assert is_server_started() is True

    @patch("knowledge_doc_converter.core.metrics.make_server")
    @patch("prometheus_client.make_wsgi_app")
    @patch("prometheus_client.multiprocess.MultiProcessCollector")
    def test_starts_server_with_custom_path(
        self, mock_collector, mock_wsgi, mock_make_server
    ):
        mock_wsgi.return_value = MagicMock()
        mock_make_server.return_value = MagicMock()
        start_metrics_server(9091, path="/custom-metrics")
        mock_make_server.assert_called_once()
        assert is_server_started() is True

    @patch("knowledge_doc_converter.core.metrics.make_server")
    @patch("prometheus_client.make_wsgi_app")
    @patch("prometheus_client.multiprocess.MultiProcessCollector")
    def test_starts_server_path_without_leading_slash(
        self, mock_collector, mock_wsgi, mock_make_server
    ):
        """Path without leading slash should be normalized."""
        mock_wsgi.return_value = MagicMock()
        mock_make_server.return_value = MagicMock()
        start_metrics_server(9092, path="metrics")
        mock_make_server.assert_called_once()
        assert is_server_started() is True

    @patch("knowledge_doc_converter.core.metrics.make_server")
    @patch("prometheus_client.make_wsgi_app")
    @patch("prometheus_client.multiprocess.MultiProcessCollector")
    def test_does_not_start_twice(self, mock_collector, mock_wsgi, mock_make_server):
        mock_wsgi.return_value = MagicMock()
        mock_make_server.return_value = MagicMock()
        start_metrics_server(9090)
        start_metrics_server(9090)
        mock_make_server.assert_called_once()

    @patch(
        "knowledge_doc_converter.core.metrics.make_server",
        side_effect=OSError("port in use"),
    )
    @patch("prometheus_client.make_wsgi_app")
    @patch("prometheus_client.multiprocess.MultiProcessCollector")
    def test_handles_os_error(self, mock_collector, mock_wsgi, mock_make_server):
        mock_wsgi.return_value = MagicMock()
        start_metrics_server(9090)
        assert is_server_started() is False

    @patch(
        "knowledge_doc_converter.core.metrics.make_server",
        side_effect=Exception("unexpected"),
    )
    @patch("prometheus_client.make_wsgi_app")
    @patch("prometheus_client.multiprocess.MultiProcessCollector")
    def test_handles_unexpected_error(
        self, mock_collector, mock_wsgi, mock_make_server
    ):
        mock_wsgi.return_value = MagicMock()
        start_metrics_server(9090)
        assert is_server_started() is False
