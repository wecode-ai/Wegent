# SPDX-FileCopyrightText: 2025 WeCode, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import logging
import os
import time
from datetime import datetime
from pathlib import Path
from typing import Generator
from zoneinfo import ZoneInfo

import pytest

from shared import logger as logger_module
from shared.logger import HourlyRotatingFileHandler, setup_logger


class QueueListenerThatRaisesOnSecondStop:
    def __init__(self):
        self._thread = object()
        self.stop_count = 0

    def stop(self):
        self.stop_count += 1
        if self.stop_count > 1:
            raise AttributeError("'NoneType' object has no attribute 'join'")
        self._thread = None


class FakeQueueListener(QueueListenerThatRaisesOnSecondStop):
    def __init__(self, log_queue, handler):
        super().__init__()
        self.log_queue = log_queue
        self.handler = handler
        self._thread = None

    def start(self):
        self._thread = object()


@pytest.fixture
def reset_file_handler(monkeypatch: pytest.MonkeyPatch) -> Generator[None, None, None]:
    monkeypatch.delenv("WEGENT_LOG_FILE_PATH", raising=False)
    yield
    if logger_module._FILE_HANDLER is not None:
        logger_module._FILE_HANDLER.close()
    logger_module._FILE_HANDLER = None
    logger_module._FILE_HANDLER_PATH = None


def test_stop_queue_listener_safely_ignores_duplicate_stop():
    """Duplicate QueueListener cleanup should not leak atexit exceptions."""
    listener = QueueListenerThatRaisesOnSecondStop()

    logger_module._stop_queue_listener_safely(listener)
    logger_module._stop_queue_listener_safely(listener)

    assert listener.stop_count == 1


def test_queue_listener_shutdown_callback_is_idempotent(mocker):
    """The atexit shutdown callback may run after explicit test cleanup."""
    registered_callbacks = []
    mocker.patch("shared.logger.os.getppid", return_value=2)
    mocker.patch("shared.logger.multiprocessing.Queue", return_value=object())
    mocker.patch("shared.logger.QueueListener", FakeQueueListener)
    mocker.patch(
        "shared.logger.atexit.register",
        side_effect=lambda *args: registered_callbacks.append(args),
    )

    logger = setup_logger("test-idempotent-queue-listener-shutdown")

    try:
        assert registered_callbacks
        callback, listener = registered_callbacks[0]
        callback(listener)
        callback(listener)
        assert listener.stop_count == 1
    finally:
        for handler in list(logger.handlers):
            logger.removeHandler(handler)
            handler.close()
        logging.Logger.manager.loggerDict.pop(logger.name, None)


def test_hourly_file_handler_rolls_over_on_next_natural_hour(tmp_path: Path) -> None:
    handler = HourlyRotatingFileHandler(
        tmp_path / "info.log",
        when="h",
        interval=1,
        backupCount=0,
        encoding="utf-8",
    )

    try:
        current_time = time.mktime((2026, 8, 20, 10, 23, 45, 0, 0, -1))

        rollover = time.localtime(handler.computeRollover(current_time))

        assert (rollover.tm_hour, rollover.tm_min, rollover.tm_sec) == (11, 0, 0)
    finally:
        handler.close()


@pytest.mark.skipif(not hasattr(time, "tzset"), reason="tzset is unavailable")
def test_hourly_archive_names_are_unique_across_dst_fall_back(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    original_tz = os.environ.get("TZ")
    monkeypatch.setenv("TZ", "America/New_York")
    time.tzset()
    handler = HourlyRotatingFileHandler(
        tmp_path / "info.log",
        when="h",
        interval=1,
        backupCount=0,
        encoding="utf-8",
    )
    handler.suffix = "%Y%m%d-%H%z"

    try:
        timezone = ZoneInfo("America/New_York")
        first_hour = datetime(2026, 11, 1, 1, 30, tzinfo=timezone, fold=0)
        second_hour = datetime(2026, 11, 1, 1, 30, tzinfo=timezone, fold=1)

        first_suffix = time.strftime(
            handler.suffix,
            time.localtime(first_hour.timestamp()),
        )
        second_suffix = time.strftime(
            handler.suffix,
            time.localtime(second_hour.timestamp()),
        )

        assert first_suffix == "20261101-01-0400"
        assert second_suffix == "20261101-01-0500"
    finally:
        handler.close()
        if original_tz is None:
            monkeypatch.delenv("TZ")
        else:
            monkeypatch.setenv("TZ", original_tz)
        time.tzset()


def test_setup_logger_writes_to_hourly_file(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    reset_file_handler: None,
) -> None:
    log_file = tmp_path / "executor_manager" / "info.log"
    monkeypatch.setenv("WEGENT_LOG_FILE_PATH", str(log_file))
    logger = setup_logger(
        "test-hourly-file-logging",
        use_multiprocessing_safe=False,
    )

    try:
        logger.info("executor manager file logging")
        assert log_file.read_text(encoding="utf-8").endswith(
            "INFO - executor manager file logging\n"
        )
        assert isinstance(logger_module._FILE_HANDLER, HourlyRotatingFileHandler)
        assert logger_module._FILE_HANDLER.suffix == "%Y%m%d-%H%z"
        assert logger_module._FILE_HANDLER.backupCount == 0
    finally:
        for handler in list(logger.handlers):
            logger.removeHandler(handler)
            if handler is not logger_module._FILE_HANDLER:
                handler.close()
        logging.Logger.manager.loggerDict.pop(logger.name, None)
