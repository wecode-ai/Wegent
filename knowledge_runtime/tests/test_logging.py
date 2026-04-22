# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for logging configuration."""

from __future__ import annotations

import logging
import os
import tempfile
from unittest.mock import patch

import pytest

from knowledge_runtime.core.logging import RequestIdFilter, setup_logging


class TestRequestIdFilter:
    """Tests for RequestIdFilter."""

    def test_filter_adds_request_id_placeholder(self) -> None:
        """Filter should add '-' as placeholder when no request_id is set."""
        filter_obj = RequestIdFilter()
        record = logging.LogRecord(
            name="test",
            level=logging.INFO,
            pathname="test.py",
            lineno=1,
            msg="test message",
            args=(),
            exc_info=None,
        )

        result = filter_obj.filter(record)

        assert result is True
        assert record.request_id == "-"

    def test_filter_adds_request_id_from_context(self) -> None:
        """Filter should add request_id from context when available."""
        filter_obj = RequestIdFilter()
        record = logging.LogRecord(
            name="test",
            level=logging.INFO,
            pathname="test.py",
            lineno=1,
            msg="test message",
            args=(),
            exc_info=None,
        )

        with patch(
            "shared.telemetry.context.span.get_request_id",
            return_value="test-request-123",
        ):
            result = filter_obj.filter(record)

        assert result is True
        assert record.request_id == "test-request-123"


class TestSetupLogging:
    """Tests for setup_logging function."""

    def test_setup_logging_console_mode(self, capsys: pytest.CaptureFixture) -> None:
        """Console mode should log to stdout."""
        # Reset root logger
        root_logger = logging.getLogger()
        root_logger.handlers.clear()

        setup_logging(log_file_enabled=False, log_dir="./logs", log_level="INFO")

        logger = logging.getLogger("test_console")
        logger.info("Test console message")

        # Check that handler is StreamHandler
        assert len(root_logger.handlers) == 1
        assert isinstance(root_logger.handlers[0], logging.StreamHandler)

    def test_setup_logging_file_mode(self) -> None:
        """File mode should create info.log and error.log files."""
        with tempfile.TemporaryDirectory() as tmpdir:
            # Reset root logger
            root_logger = logging.getLogger()
            root_logger.handlers.clear()

            setup_logging(log_file_enabled=True, log_dir=tmpdir, log_level="DEBUG")

            logger = logging.getLogger("test_file")
            logger.info("Test info message")
            logger.error("Test error message")

            # Check that files are created
            assert os.path.exists(os.path.join(tmpdir, "info.log"))
            assert os.path.exists(os.path.join(tmpdir, "error.log"))

            # info.log should contain both messages
            with open(os.path.join(tmpdir, "info.log")) as f:
                info_content = f.read()
            assert "Test info message" in info_content
            assert "Test error message" in info_content

            # error.log should only contain error message
            with open(os.path.join(tmpdir, "error.log")) as f:
                error_content = f.read()
            assert "Test info message" not in error_content
            assert "Test error message" in error_content

    def test_setup_logging_respects_log_level(self) -> None:
        """Log level should be respected."""
        with tempfile.TemporaryDirectory() as tmpdir:
            # Reset root logger
            root_logger = logging.getLogger()
            root_logger.handlers.clear()

            setup_logging(log_file_enabled=True, log_dir=tmpdir, log_level="WARNING")

            logger = logging.getLogger("test_level")
            logger.debug("Debug message - should not appear")
            logger.info("Info message - should not appear")
            logger.warning("Warning message - should appear")

            with open(os.path.join(tmpdir, "info.log")) as f:
                content = f.read()

            assert "Debug message" not in content
            assert "Info message" not in content
            assert "Warning message" in content

    def test_setup_logging_creates_log_directory(self) -> None:
        """Log directory should be created if it doesn't exist."""
        with tempfile.TemporaryDirectory() as tmpdir:
            log_dir = os.path.join(tmpdir, "nested", "logs")

            # Reset root logger
            root_logger = logging.getLogger()
            root_logger.handlers.clear()

            setup_logging(log_file_enabled=True, log_dir=log_dir, log_level="INFO")

            assert os.path.exists(log_dir)
            assert os.path.exists(os.path.join(log_dir, "info.log"))

    def test_setup_logging_suppresses_third_party_logs(self) -> None:
        """Third-party library logs should be configured correctly."""
        # Reset root logger
        root_logger = logging.getLogger()
        root_logger.handlers.clear()

        setup_logging(log_file_enabled=False, log_dir="./logs", log_level="INFO")

        # uvicorn and fastapi should propagate
        assert logging.getLogger("uvicorn").propagate is True
        assert logging.getLogger("uvicorn.error").propagate is True
        assert logging.getLogger("fastapi").propagate is True

        # httpx should be set to WARNING level
        assert logging.getLogger("httpx").level == logging.WARNING
        assert logging.getLogger("httpcore").level == logging.WARNING

    def test_setup_logging_access_log_separate_file(self) -> None:
        """Access logs should be written to a separate file."""
        with tempfile.TemporaryDirectory() as tmpdir:
            # Reset root logger
            root_logger = logging.getLogger()
            root_logger.handlers.clear()

            setup_logging(log_file_enabled=True, log_dir=tmpdir, log_level="INFO")

            # Log application message
            app_logger = logging.getLogger("test_app")
            app_logger.info("Application message")

            # Log access message (simulating uvicorn.access)
            access_logger = logging.getLogger("uvicorn.access")
            access_logger.info("127.0.0.1:12345 - GET /health 200")

            # Check that access.log is created
            assert os.path.exists(os.path.join(tmpdir, "access.log"))
            assert os.path.exists(os.path.join(tmpdir, "info.log"))

            # access.log should contain only access messages
            with open(os.path.join(tmpdir, "access.log")) as f:
                access_content = f.read()
            assert "GET /health 200" in access_content
            assert "Application message" not in access_content

            # info.log should contain application messages but not access messages
            with open(os.path.join(tmpdir, "info.log")) as f:
                info_content = f.read()
            assert "Application message" in info_content
            assert "GET /health 200" not in info_content

    def test_setup_logging_access_log_console_mode(self) -> None:
        """Access logs should propagate to console in console mode."""
        # Reset root logger
        root_logger = logging.getLogger()
        root_logger.handlers.clear()

        setup_logging(log_file_enabled=False, log_dir="./logs", log_level="INFO")

        # In console mode, access logs should propagate to root logger
        access_logger = logging.getLogger("uvicorn.access")
        assert access_logger.propagate is True
        assert len(access_logger.handlers) == 0
