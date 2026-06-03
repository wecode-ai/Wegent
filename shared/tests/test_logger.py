# SPDX-FileCopyrightText: 2025 WeCode, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import logging

from shared import logger as logger_module
from shared.logger import setup_logger


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
