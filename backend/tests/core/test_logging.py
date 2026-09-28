# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import logging

from app.core.logging import (
    SensitiveDataFormatter,
    WebsocketProtocolDebugFilter,
    setup_logging,
)


def test_sensitive_data_formatter_masks_jwt_tokens() -> None:
    formatter = SensitiveDataFormatter("%(message)s")
    record = logging.LogRecord(
        name="test",
        level=logging.INFO,
        pathname=__file__,
        lineno=1,
        msg="auth_token=eyJheader.eyJpayload.signature",
        args=(),
        exc_info=None,
    )

    output = formatter.format(record)

    assert "eyJheader.eyJpayload.signature" not in output


def test_setup_logging_suppresses_websocket_frame_debug_logs(monkeypatch) -> None:
    root_logger = logging.getLogger()
    websocket_logger = logging.getLogger("websockets")
    uvicorn_error_logger = logging.getLogger("uvicorn.error")
    original_root_level = root_logger.level
    original_root_handlers = list(root_logger.handlers)
    original_websocket_level = websocket_logger.level
    original_uvicorn_error_filters = list(uvicorn_error_logger.filters)
    monkeypatch.setenv("LOG_LEVEL", "DEBUG")

    try:
        setup_logging()
        setup_logging()

        assert root_logger.level == logging.DEBUG
        assert websocket_logger.level == logging.INFO
        assert (
            logging.getLogger("websockets.legacy.protocol").getEffectiveLevel()
            == logging.INFO
        )
        protocol_record = logging.LogRecord(
            name="uvicorn.error",
            level=logging.DEBUG,
            pathname="/site-packages/websockets/legacy/protocol.py",
            lineno=1154,
            msg="< BINARY 00 00",
            args=(),
            exc_info=None,
        )
        assert all(
            not handler.filter(protocol_record) for handler in root_logger.handlers
        )
        assert not uvicorn_error_logger.filter(protocol_record)
        assert (
            sum(
                isinstance(filter_, WebsocketProtocolDebugFilter)
                for filter_ in uvicorn_error_logger.filters
            )
            == 1
        )
    finally:
        root_logger.handlers.clear()
        root_logger.handlers.extend(original_root_handlers)
        root_logger.setLevel(original_root_level)
        websocket_logger.setLevel(original_websocket_level)
        uvicorn_error_logger.filters.clear()
        uvicorn_error_logger.filters.extend(original_uvicorn_error_filters)


def test_websocket_protocol_filter_preserves_non_frame_debug_and_info_logs() -> None:
    filter_ = WebsocketProtocolDebugFilter()
    app_debug = logging.LogRecord(
        name="app.api.devices",
        level=logging.DEBUG,
        pathname="/workspace/backend/app/api/devices.py",
        lineno=1,
        msg="session created",
        args=(),
        exc_info=None,
    )
    protocol_info = logging.LogRecord(
        name="uvicorn.error",
        level=logging.INFO,
        pathname="/site-packages/websockets/legacy/protocol.py",
        lineno=1,
        msg="connection open",
        args=(),
        exc_info=None,
    )

    assert filter_.filter(app_debug)
    assert filter_.filter(protocol_info)
