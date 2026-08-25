# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import logging

from app.core.logging import SensitiveDataFormatter


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
