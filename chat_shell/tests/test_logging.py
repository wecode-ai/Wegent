# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import logging

from chat_shell.core.logging import RelativePathFormatter


def test_relative_path_formatter_masks_jwt_tokens() -> None:
    formatter = RelativePathFormatter("%(message)s", base_path="/tmp")
    record = logging.LogRecord(
        name="test",
        level=logging.INFO,
        pathname="/tmp/service.py",
        lineno=1,
        msg="skill_identity_token=eyJheader.eyJpayload.signature",
        args=(),
        exc_info=None,
    )

    output = formatter.format(record)

    assert "eyJheader.eyJpayload.signature" not in output
